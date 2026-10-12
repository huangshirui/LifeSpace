import type { Permission, SpaceRole } from "./authorization";
import {
  delegationChainStatement,
  delegationCurrent,
  groupDelegationChainRows,
  resolveAgentApiDelegatedPrincipal,
  validateStructuralDelegationChain,
  type DelegationChainRow,
} from "./delegation-chain";
import { ENTITY_ROLE_CAPABILITIES, type AuthoritySource } from "./entity-role-capability";
import type { Actor, Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { ModelAccess } from "./model-definition";
export type ModelAuthorityTarget = { key: string; definition: { access: ModelAccess[] } };

const accessRank: Record<ModelAccess, number> = { read: 2, write: 3, manage: 4 };
const permissionRank: Record<Permission, number> = { free_busy: 1, read: 2, write: 3, manage: 4 };
const stableScopes: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};
const spacePermissions: Record<ModelAccess, Permission> = {
  read: "read",
  write: "write",
  manage: "manage",
};
const roleMaxAccess: Record<SpaceRole, ModelAccess> = {
  owner: "manage",
  admin: "manage",
  editor: "write",
  viewer: "read",
};
const permissionMaxAccess: Record<Permission, ModelAccess | null> = {
  free_busy: null,
  read: "read",
  write: "write",
  manage: "manage",
};

export type DelegationSelector = {
  delegationId?: string | null;
  recordId?: string | null;
};

export type ModelAccessRequest = {
  model: ModelAuthorityTarget;
  required: ModelAccess;
  selector?: DelegationSelector;
};

export type ModelAuthorityDecision = {
  applicationId: string;
  modelKey: string;
  required: ModelAccess;
  catalogAccess: ModelAccess;
  spaceAuthority: SpaceRole | "grant";
  delegationId: string | null;
  delegationChain: string[];
  singleUseDelegationIds: string[];
  singleUse: boolean;
};

export type ModelPolicyIdentity = {
  principalPersonId: string | null;
  actorPersonId: string | null;
};

export type ModelAccessDecision = {
  principal: Principal;
  authority: ModelAuthorityDecision;
  policyIdentity: ModelPolicyIdentity;
};

export type ModelAccessEvaluation =
  | { ok: true; decision: ModelAccessDecision }
  | { ok: false; error: ApiError };

type BaseAuthoritySnapshotRow = {
  space_exists: number;
  catalog_access: ModelAccess | null;
  membership_role: SpaceRole | null;
  grant_permission: Permission | null;
  principal_person_id: string | null;
};

type PreparedAccess = {
  baseKey: string;
  request: ModelAccessRequest;
  delegationId: string | null;
  recordId: string | null;
};

type PreparedBaseAuthority = {
  key: string;
  model: ModelAuthorityTarget;
  statement: D1PreparedStatement;
};

function executionActor(principal: Principal): Actor {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

function selectorValues(principal: Principal, selector: DelegationSelector | undefined) {
  const represented = Boolean(principal.actor);
  const delegationId = selector?.delegationId?.trim() || null;
  const recordId = selector?.recordId?.trim() || null;
  if (represented && !delegationId) {
    throw new ApiError("DELEGATION_REQUIRED", "Represented execution requires an explicit Delegation selector", 403);
  }
  if (!represented && delegationId) {
    throw new ApiError("DELEGATION_INVALID", "Direct execution cannot exercise a Delegation", 403);
  }
  return { represented, delegationId, recordId };
}

function preflight(principal: Principal, request: ModelAccessRequest): void {
  if (!request.model.definition.access.includes(request.required)) {
    throw new ApiError(
      "MODEL_OPERATION_UNSUPPORTED",
      `Model ${request.model.key} does not expose ${request.required} access`,
      405,
    );
  }
  const scope = stableScopes[request.required];
  if (!principal.scopes.includes(scope)) {
    throw new ApiError("CREDENTIAL_SCOPE_INSUFFICIENT", `Scope ${scope} is required`, 403);
  }
}

function baseAuthorityKey(
  principal: Principal,
  spaceId: string,
  model: ModelAuthorityTarget,
): string {
  return [
    principal.clientId,
    principal.type,
    principal.id,
    spaceId,
    model.key,
  ].join("\u001f");
}

function authoritySources(principal: Principal): readonly AuthoritySource[] {
  return ENTITY_ROLE_CAPABILITIES[principal.type].authoritySources as readonly AuthoritySource[];
}

function baseAuthorityStatement(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: ModelAuthorityTarget,
): D1PreparedStatement {
  const sources = authoritySources(principal);
  const bindings: unknown[] = [
    spaceId,
    principal.clientId,
    model.key,
  ];

  const membershipProjection = sources.includes("membership")
    ? `(
        SELECT role FROM space_memberships
        WHERE space_id=? AND user_id=? AND deleted_at IS NULL LIMIT 1
      )`
    : "NULL";
  if (sources.includes("membership")) {
    bindings.push(spaceId, principal.id);
  }

  const dataGrantProjection = sources.includes("dataGrant")
    ? `(
        SELECT permission FROM data_grants
        WHERE source_space_id=? AND grantee_type=? AND grantee_id=?
          AND (
            (resource_type='space' AND resource_id IS NULL)
            OR (resource_type='model' AND resource_id=?)
          )
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
        ORDER BY CASE permission
          WHEN 'manage' THEN 4 WHEN 'write' THEN 3 WHEN 'read' THEN 2 ELSE 1 END DESC
        LIMIT 1
      )`
    : "NULL";
  if (sources.includes("dataGrant")) {
    bindings.push(spaceId, principal.type, principal.id, model.key);
  }

  // Space Person is Policy Identity, not an Authority Source. Keep this bridge
  // independent from Entity Role Capability.authoritySources.
  bindings.push(principal.type, spaceId, principal.id);

  return env.DB.prepare(`
    SELECT
      CASE WHEN EXISTS(
        SELECT 1 FROM spaces WHERE id=? AND deleted_at IS NULL
      ) THEN 1 ELSE 0 END AS space_exists,
      (
        SELECT max_access FROM application_model_access
        WHERE application_id=? AND model_key=? LIMIT 1
      ) AS catalog_access,
      ${membershipProjection} AS membership_role,
      ${dataGrantProjection} AS grant_permission,
      (
        SELECT id FROM space_people
        WHERE ?='user' AND space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1
      ) AS principal_person_id
  `).bind(...bindings);
}

function delegationScopeAllows(
  row: DelegationChainRow,
  spaceId: string,
  modelKey: string,
  recordId: string | null,
  required: ModelAccess,
): boolean {
  if (permissionRank[row.delegation_max_access] < accessRank[required]) return false;
  if (row.delegation_target_type === "space") return row.delegation_target_id === spaceId;
  if (row.delegation_target_type === "model") return row.delegation_target_id === modelKey;
  return Boolean(recordId)
    && row.delegation_target_id === recordId
    && row.delegation_target_model_key === modelKey;
}

function validateDelegationChain(
  principal: Principal,
  spaceId: string,
  prepared: PreparedAccess,
  rows: readonly DelegationChainRow[],
): {
  delegationId: string;
  delegationChain: string[];
  singleUseDelegationIds: string[];
} {
  if (!prepared.delegationId) {
    throw new ApiError("DELEGATION_INVALID", "Delegation chain was not selected", 403);
  }

  const rootToLeaf = validateStructuralDelegationChain(
    principal,
    spaceId,
    prepared.delegationId,
    rows,
  );

  for (const row of rootToLeaf) {
    if (!delegationScopeAllows(
      row,
      spaceId,
      prepared.request.model.key,
      prepared.recordId,
      prepared.request.required,
    )) {
      throw new ApiError(
        "DELEGATION_SCOPE_INSUFFICIENT",
        `Delegation chain does not allow ${prepared.request.required} access to this target`,
        403,
      );
    }
  }

  return {
    delegationId: prepared.delegationId,
    delegationChain: rootToLeaf.map((row) => row.delegation_id),
    singleUseDelegationIds: rootToLeaf
      .filter((row) => row.delegation_max_uses === 1)
      .map((row) => row.delegation_id),
  };
}

function baseDecision(
  principal: Principal,
  spaceId: string,
  request: ModelAccessRequest,
  row: BaseAuthoritySnapshotRow | null,
): Pick<ModelAuthorityDecision, "catalogAccess" | "spaceAuthority"> {
  if (!row || row.space_exists !== 1) {
    throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  }

  if (!row.catalog_access || accessRank[row.catalog_access] < accessRank[request.required]) {
    throw new ApiError(
      "APPLICATION_ACCESS_INSUFFICIENT",
      `Application ${principal.clientId} is not allowed ${request.required} access to model ${request.model.key}`,
      403,
    );
  }

  const membershipAccess = row.membership_role ? roleMaxAccess[row.membership_role] : null;
  const grantAccess = row.grant_permission ? permissionMaxAccess[row.grant_permission] : null;
  const membershipAllowed = membershipAccess !== null
    && accessRank[membershipAccess] >= accessRank[request.required];
  const grantAllowed = grantAccess !== null
    && grantAccess !== undefined
    && accessRank[grantAccess] >= accessRank[request.required];
  if (!membershipAllowed && !grantAllowed) {
    throw new ApiError(
      "PRINCIPAL_AUTHORITY_INSUFFICIENT",
      `Space ${spacePermissions[request.required]} permission is required`,
      403,
    );
  }

  return {
    catalogAccess: row.catalog_access,
    spaceAuthority: membershipAllowed ? row.membership_role! : "grant",
  };
}

function policyIdentity(
  principal: Principal,
  row: BaseAuthoritySnapshotRow,
): ModelPolicyIdentity {
  const actor = executionActor(principal);
  const principalPersonId = row.principal_person_id;

  // Current supported profiles do not include represented User -> different User.
  // Reuse the Principal Person for the hot direct-User path and keep Agent/Service/
  // Device actors out of Space Person semantics.
  const actorPersonId = actor.type === "user"
    && principal.type === "user"
    && actor.id === principal.id
    ? principalPersonId
    : null;

  return { principalPersonId, actorPersonId };
}

function decisionFromSnapshots(
  principal: Principal,
  spaceId: string,
  prepared: PreparedAccess,
  baseRow: BaseAuthoritySnapshotRow | null,
  delegationRows: readonly DelegationChainRow[],
): ModelAccessDecision {
  const base = baseDecision(principal, spaceId, prepared.request, baseRow);
  let resolvedDelegationId: string | null = null;
  let delegationChain: string[] = [];
  let singleUseDelegationIds: string[] = [];

  if (principal.actor) {
    const chain = validateDelegationChain(principal, spaceId, prepared, delegationRows);
    resolvedDelegationId = chain.delegationId;
    delegationChain = chain.delegationChain;
    singleUseDelegationIds = chain.singleUseDelegationIds;
  }

  if (!baseRow) {
    throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  }

  return {
    principal,
    authority: {
      applicationId: principal.clientId,
      modelKey: prepared.request.model.key,
      required: prepared.request.required,
      ...base,
      delegationId: resolvedDelegationId,
      delegationChain,
      singleUseDelegationIds,
      singleUse: singleUseDelegationIds.length > 0,
    },
    policyIdentity: policyIdentity(principal, baseRow),
  };
}

function prepareAccess(
  principal: Principal,
  spaceId: string,
  request: ModelAccessRequest,
): PreparedAccess {
  preflight(principal, request);
  const { delegationId, recordId } = selectorValues(principal, request.selector);
  return {
    baseKey: baseAuthorityKey(principal, spaceId, request.model),
    request,
    delegationId,
    recordId,
  };
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  throw error;
}

/** Internal durable-intent executor: direct roots only, current-state facts in one batch.
 * This is not a credential resolver and must never receive request-supplied identities.
 */
export async function evaluateRecurrenceRoots(env: Bindings, entries: readonly {
  principal: Principal; spaceId: string; request: ModelAccessRequest;
}[]): Promise<ModelAccessEvaluation[]> {
  const bases = new Map<string, D1PreparedStatement>();
  const prepared = entries.map(entry => {
    try {
      if (entry.principal.actor || entry.request.selector?.delegationId) throw new ApiError("DELEGATION_INVALID", "Recurring intent uses its enrolled root", 403);
      const value = prepareAccess(entry.principal, entry.spaceId, entry.request);
      if (!bases.has(value.baseKey)) bases.set(value.baseKey, baseAuthorityStatement(env, entry.principal, entry.spaceId, entry.request.model));
      return { value };
    } catch (error) { return { error: asApiError(error) }; }
  });
  const keys = [...bases.keys()];
  const results = keys.length ? await env.DB.batch<BaseAuthoritySnapshotRow>([...bases.values()]) : [];
  const rows = new Map(keys.map((key, index) => [key, results[index]?.results[0] ?? null]));
  return prepared.map((item, index) => {
    if (!item.value) return { ok: false, error: item.error! };
    try { return { ok: true, decision: decisionFromSnapshots(entries[index]!.principal, entries[index]!.spaceId, item.value, rows.get(item.value.baseKey) ?? null, []) }; }
    catch (error) { return { ok: false, error: asApiError(error) }; }
  });
}

async function evaluateModelAccessManyResolved(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
  preloadedChains: Map<string, DelegationChainRow[]> | null = null,
): Promise<ModelAccessEvaluation[]> {
  if (!requests.length) return [];

  const prepared = requests.map((request) => {
    try {
      return { ok: true as const, value: prepareAccess(principal, spaceId, request) };
    } catch (error) {
      return { ok: false as const, error: asApiError(error) };
    }
  });
  const baseEntries = new Map<string, PreparedBaseAuthority>();
  const leafIds = new Set<string>();

  for (const result of prepared) {
    if (!result.ok) continue;
    const entry = result.value;
    if (!baseEntries.has(entry.baseKey)) {
      baseEntries.set(entry.baseKey, {
        key: entry.baseKey,
        model: entry.request.model,
        statement: baseAuthorityStatement(env, principal, spaceId, entry.request.model),
      });
    }
    if (entry.delegationId) leafIds.add(entry.delegationId);
  }

  const uniqueBases = [...baseEntries.values()];
  const uniqueLeafIds = [...leafIds];
  const shouldLoadChains = preloadedChains === null && uniqueLeafIds.length > 0;
  const statements = [
    ...uniqueBases.map((entry) => entry.statement),
    ...(shouldLoadChains ? [delegationChainStatement(env, uniqueLeafIds)] : []),
  ];
  const results = statements.length
    ? await env.DB.batch<Record<string, unknown>>(statements)
    : [];

  const baseRows = new Map<string, BaseAuthoritySnapshotRow | null>();
  uniqueBases.forEach((entry, index) => {
    const row = (results[index]?.results ?? [])[0] as BaseAuthoritySnapshotRow | undefined;
    baseRows.set(entry.key, row ?? null);
  });

  const chainsByLeaf = preloadedChains ?? (shouldLoadChains
    ? groupDelegationChainRows(
        (results[uniqueBases.length]?.results ?? []) as DelegationChainRow[],
      )
    : new Map<string, DelegationChainRow[]>());

  return prepared.map((result) => {
    if (!result.ok) return { ok: false as const, error: result.error };
    const entry = result.value;
    try {
      return {
        ok: true as const,
        decision: decisionFromSnapshots(
          principal,
          spaceId,
          entry,
          baseRows.get(entry.baseKey) ?? null,
          entry.delegationId ? chainsByLeaf.get(entry.delegationId) ?? [] : [],
        ),
      };
    } catch (error) {
      return { ok: false as const, error: asApiError(error) };
    }
  });
}

async function requireModelAccessManyResolved(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
  preloadedChains: Map<string, DelegationChainRow[]> | null = null,
): Promise<ModelAccessDecision[]> {
  const evaluated = await evaluateModelAccessManyResolved(env, principal, spaceId, requests, preloadedChains);
  return evaluated.map((entry) => {
    if (!entry.ok) throw entry.error;
    return entry.decision;
  });
}

export async function evaluateModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessEvaluation[]> {
  if (!requests.length) return [];

  const agentApiCredential = principal.type === "agent" && !principal.actor && principal.purpose === "agent_api";
  if (!agentApiCredential) return evaluateModelAccessManyResolved(env, principal, spaceId, requests);

  const delegationIds = requests.map((request) => request.selector?.delegationId?.trim() || null);
  const selected = delegationIds.filter((value): value is string => Boolean(value));
  if (!selected.length) return evaluateModelAccessManyResolved(env, principal, spaceId, requests);
  if (selected.length !== delegationIds.length) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "One Agent API credential Bulk cannot mix direct Agent authority and represented Delegation authority",
      403,
    );
  }

  const uniqueLeafIds = [...new Set(selected)];
  const [result] = await env.DB.batch<Record<string, unknown>>([
    delegationChainStatement(env, uniqueLeafIds),
  ]);
  const chainsByLeaf = groupDelegationChainRows((result?.results ?? []) as DelegationChainRow[]);
  const resolved = selected.map((delegationId) => {
    try {
      return { ok: true as const, principal: resolveAgentApiDelegatedPrincipal(
        principal,
        spaceId,
        delegationId,
        chainsByLeaf.get(delegationId) ?? [],
      ) };
    } catch (error) {
      return { ok: false as const, error: asApiError(error) };
    }
  });
  const valid = resolved.filter((entry): entry is Extract<typeof entry, { ok: true }> => entry.ok);
  if (!valid.length) {
    return resolved.map((entry) => entry.ok
      ? { ok: false as const, error: new ApiError("DELEGATION_INVALID", "Delegation could not resolve a Root Principal", 403) }
      : { ok: false as const, error: entry.error });
  }
  const first = valid[0]!.principal;
  if (valid.some((entry) => entry.principal.type !== first.type || entry.principal.id !== first.id || entry.principal.actor?.id !== first.actor?.id)) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "One Agent API credential Bulk must resolve to one Root Principal",
      403,
    );
  }

  const validIndexes = resolved.flatMap((entry, index) => entry.ok ? [index] : []);
  const evaluatedValid = await evaluateModelAccessManyResolved(
    env,
    first,
    spaceId,
    validIndexes.map((index) => requests[index]!),
    chainsByLeaf,
  );
  const byIndex = new Map(validIndexes.map((index, offset) => [index, evaluatedValid[offset]!]));
  return resolved.map((entry, index) => entry.ok
    ? byIndex.get(index)!
    : { ok: false as const, error: entry.error });
}

export async function requireModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessDecision[]> {
  if (!requests.length) return [];

  const agentApiCredential = principal.type === "agent" && !principal.actor && principal.purpose === "agent_api";
  if (!agentApiCredential) return requireModelAccessManyResolved(env, principal, spaceId, requests);

  const delegationIds = requests.map((request) => request.selector?.delegationId?.trim() || null);
  const selected = delegationIds.filter((value): value is string => Boolean(value));
  if (!selected.length) return requireModelAccessManyResolved(env, principal, spaceId, requests);
  if (selected.length !== delegationIds.length) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "One Agent API credential request batch cannot mix direct Agent authority and represented Delegation authority",
      403,
    );
  }

  // Principal identity is deliberately not supplied by the adapter. Resolve it from
  // the current Delegation chain selected by dlg_*. This is one bounded extra D1 RTT
  // for opaque Agent credentials and never becomes an item-by-item waterfall.
  const uniqueLeafIds = [...new Set(selected)];
  const [result] = await env.DB.batch<Record<string, unknown>>([
    delegationChainStatement(env, uniqueLeafIds),
  ]);
  const chainsByLeaf = groupDelegationChainRows((result?.results ?? []) as DelegationChainRow[]);
  const resolved = selected.map((delegationId) => resolveAgentApiDelegatedPrincipal(
    principal,
    spaceId,
    delegationId,
    chainsByLeaf.get(delegationId) ?? [],
  ));
  const first = resolved[0]!;
  if (resolved.some((entry) => entry.type !== first.type || entry.id !== first.id || entry.actor?.id !== first.actor?.id)) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "One Agent API credential request batch must resolve to one Root Principal",
      403,
    );
  }
  return requireModelAccessManyResolved(env, first, spaceId, requests, chainsByLeaf);
}

export async function requireModelAccess(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: ModelAuthorityTarget,
  required: ModelAccess,
  selector: DelegationSelector = {},
): Promise<ModelAccessDecision> {
  const [decision] = await requireModelAccessMany(env, principal, spaceId, [{
    model,
    required,
    selector,
  }]);
  return decision!;
}

export async function consumeSingleUseRead(
  env: Bindings,
  decision: ModelAccessDecision,
): Promise<void> {
  const ids = decision.authority.singleUseDelegationIds;
  if (!ids.length) return;

  const consumedAt = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  const expected = ids.length;
  const result = await env.DB.prepare(`UPDATE delegations
    SET consumed_at=?,consumed_by_change_id=NULL
    WHERE id IN (${placeholders})
      AND max_uses=1
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
      AND (
        SELECT COUNT(*)
        FROM delegations required
        WHERE required.id IN (${placeholders})
          AND required.max_uses=1
          AND required.consumed_at IS NULL
          AND required.revoked_at IS NULL
          AND (required.expires_at IS NULL OR julianday(required.expires_at)>julianday('now'))
      )=?
  `).bind(consumedAt, ...ids, ...ids, expected).run();

  if (result.meta.changes !== expected) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "Single-use Delegation chain was consumed, revoked or expired before the read completed",
      403,
    );
  }
}

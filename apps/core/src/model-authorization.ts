import type { Permission, SpaceRole } from "./authorization";
import type { Actor, Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { ModelAccess } from "./model-definition";
import type { PublishedModel } from "./model-registry";

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
  model: PublishedModel;
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
  singleUse: boolean;
};

export type ModelPolicyIdentity = {
  principalPersonId: string | null;
  actorPersonId: string | null;
};

export type ModelAccessDecision = {
  authority: ModelAuthorityDecision;
  policyIdentity: ModelPolicyIdentity;
};

type BaseAuthoritySnapshotRow = {
  space_exists: number;
  catalog_access: ModelAccess | null;
  membership_role: SpaceRole | null;
  grant_permission: Permission | null;
  principal_person_id: string | null;
};

type DelegationSnapshotRow = {
  delegation_id: string;
  delegation_revoked_at: string | null;
  delegation_expires_at: string | null;
  delegation_max_uses: number | null;
  delegation_consumed_at: string | null;
  delegation_target_type: "space" | "model" | "record";
  delegation_target_id: string;
  delegation_target_model_key: string | null;
  delegation_max_access: Permission;
};

type PreparedAccess = {
  baseKey: string;
  delegationKey: string | null;
  request: ModelAccessRequest;
  delegationId: string | null;
  recordId: string | null;
};

type PreparedBaseAuthority = {
  key: string;
  model: PublishedModel;
  statement: D1PreparedStatement;
};

type PreparedDelegation = {
  key: string;
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
  model: PublishedModel,
): string {
  return [
    principal.clientId,
    principal.type,
    principal.id,
    spaceId,
    model.key,
  ].join("\u001f");
}

function delegationKey(
  principal: Principal,
  spaceId: string,
  delegationId: string,
): string {
  const actor = executionActor(principal);
  return [
    principal.clientId,
    principal.type,
    principal.id,
    actor.type,
    actor.id,
    spaceId,
    delegationId,
  ].join("\u001f");
}

function baseAuthorityStatement(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
): D1PreparedStatement {
  return env.DB.prepare(`
    SELECT
      CASE WHEN EXISTS(
        SELECT 1 FROM spaces WHERE id=? AND deleted_at IS NULL
      ) THEN 1 ELSE 0 END AS space_exists,
      (
        SELECT max_access FROM application_model_access
        WHERE application_id=? AND model_key=? LIMIT 1
      ) AS catalog_access,
      (
        SELECT role FROM space_memberships
        WHERE ?='user' AND space_id=? AND user_id=? AND deleted_at IS NULL LIMIT 1
      ) AS membership_role,
      (
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
      ) AS grant_permission,
      (
        SELECT id FROM space_people
        WHERE ?='user' AND space_id=? AND linked_user_id=? AND deleted_at IS NULL LIMIT 1
      ) AS principal_person_id
  `).bind(
    spaceId,
    principal.clientId,
    model.key,
    principal.type,
    spaceId,
    principal.id,
    spaceId,
    principal.type,
    principal.id,
    model.key,
    principal.type,
    spaceId,
    principal.id,
  );
}

function delegationStatement(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  delegationId: string,
): D1PreparedStatement {
  const actor = executionActor(principal);
  return env.DB.prepare(`
    SELECT
      d.id AS delegation_id,
      d.revoked_at AS delegation_revoked_at,
      d.expires_at AS delegation_expires_at,
      d.max_uses AS delegation_max_uses,
      d.consumed_at AS delegation_consumed_at,
      ds.target_type AS delegation_target_type,
      ds.target_id AS delegation_target_id,
      ds.target_model_key AS delegation_target_model_key,
      ds.max_access AS delegation_max_access
    FROM delegations d
    JOIN delegation_scopes ds ON ds.delegation_id=d.id
    WHERE d.id=?
      AND d.principal_type=?
      AND d.principal_id=?
      AND d.actor_type=?
      AND d.actor_id=?
      AND d.application_id=?
      AND d.source_space_id=?
    LIMIT 1
  `).bind(
    delegationId,
    principal.type,
    principal.id,
    actor.type,
    actor.id,
    principal.clientId,
    spaceId,
  );
}

function delegationCurrent(row: DelegationSnapshotRow | null): boolean {
  if (!row || row.delegation_revoked_at || row.delegation_consumed_at) return false;
  if (!row.delegation_expires_at) return true;
  return Date.parse(row.delegation_expires_at) > Date.now();
}

function delegationScopeAllows(
  row: DelegationSnapshotRow,
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
  delegationRow: DelegationSnapshotRow | null,
): ModelAccessDecision {
  const base = baseDecision(principal, spaceId, prepared.request, baseRow);
  let resolvedDelegationId: string | null = null;
  let singleUse = false;

  if (principal.actor) {
    if (!prepared.delegationId || !delegationCurrent(delegationRow)) {
      throw new ApiError(
        "DELEGATION_INVALID",
        "Delegation is missing, revoked, expired or already consumed",
        403,
      );
    }
    if (!delegationRow || !delegationScopeAllows(
      delegationRow,
      spaceId,
      prepared.request.model.key,
      prepared.recordId,
      prepared.request.required,
    )) {
      throw new ApiError(
        "DELEGATION_SCOPE_INSUFFICIENT",
        `Delegation scope does not allow ${prepared.request.required} access to this target`,
        403,
      );
    }
    resolvedDelegationId = delegationRow.delegation_id;
    singleUse = delegationRow.delegation_max_uses === 1;
  }

  if (!baseRow) {
    throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  }

  return {
    authority: {
      applicationId: principal.clientId,
      modelKey: prepared.request.model.key,
      required: prepared.request.required,
      ...base,
      delegationId: resolvedDelegationId,
      singleUse,
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
    delegationKey: delegationId ? delegationKey(principal, spaceId, delegationId) : null,
    request,
    delegationId,
    recordId,
  };
}

export async function requireModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessDecision[]> {
  if (!requests.length) return [];

  const prepared = requests.map((request) => prepareAccess(principal, spaceId, request));
  const baseEntries = new Map<string, PreparedBaseAuthority>();
  const delegationEntries = new Map<string, PreparedDelegation>();

  for (const entry of prepared) {
    if (!baseEntries.has(entry.baseKey)) {
      baseEntries.set(entry.baseKey, {
        key: entry.baseKey,
        model: entry.request.model,
        statement: baseAuthorityStatement(env, principal, spaceId, entry.request.model),
      });
    }
    if (entry.delegationKey && entry.delegationId && !delegationEntries.has(entry.delegationKey)) {
      delegationEntries.set(entry.delegationKey, {
        key: entry.delegationKey,
        statement: delegationStatement(env, principal, spaceId, entry.delegationId),
      });
    }
  }

  const uniqueBases = [...baseEntries.values()];
  const uniqueDelegations = [...delegationEntries.values()];
  const results = await env.DB.batch<Record<string, unknown>>([
    ...uniqueBases.map((entry) => entry.statement),
    ...uniqueDelegations.map((entry) => entry.statement),
  ]);

  const baseRows = new Map<string, BaseAuthoritySnapshotRow | null>();
  uniqueBases.forEach((entry, index) => {
    const row = (results[index]?.results ?? [])[0] as BaseAuthoritySnapshotRow | undefined;
    baseRows.set(entry.key, row ?? null);
  });

  const delegationRows = new Map<string, DelegationSnapshotRow | null>();
  uniqueDelegations.forEach((entry, index) => {
    const resultIndex = uniqueBases.length + index;
    const row = (results[resultIndex]?.results ?? [])[0] as DelegationSnapshotRow | undefined;
    delegationRows.set(entry.key, row ?? null);
  });

  return prepared.map((entry) => decisionFromSnapshots(
    principal,
    spaceId,
    entry,
    baseRows.get(entry.baseKey) ?? null,
    entry.delegationKey ? delegationRows.get(entry.delegationKey) ?? null : null,
  ));
}

export async function requireModelAccess(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
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
  if (!decision.authority.singleUse || !decision.authority.delegationId) return;
  const consumedAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE delegations
    SET consumed_at=?,consumed_by_change_id=NULL
    WHERE id=?
      AND max_uses=1
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`)
    .bind(consumedAt, decision.authority.delegationId)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "Single-use Delegation was consumed, revoked or expired before the read completed",
      403,
    );
  }
}

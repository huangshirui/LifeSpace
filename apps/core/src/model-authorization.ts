import type { Permission, SpaceRole } from "./authorization";
import type { Actor, ActorType, Bindings, Principal, PrincipalType } from "./env";
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
  delegationChain: string[];
  singleUseDelegationIds: string[];
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
  root_leaf_id: string;
  delegation_id: string;
  parent_delegation_id: string | null;
  remaining_redelegation_depth: number;
  principal_type: PrincipalType;
  principal_id: string;
  actor_type: ActorType;
  actor_id: string;
  application_id: string;
  source_space_id: string;
  created_by_type: ActorType;
  created_by_id: string;
  delegation_revoked_at: string | null;
  delegation_expires_at: string | null;
  delegation_max_uses: number | null;
  delegation_consumed_at: string | null;
  delegation_target_type: "space" | "model" | "record";
  delegation_target_id: string;
  delegation_target_model_key: string | null;
  delegation_max_access: Permission;
  chain_depth: number;
};

type PreparedAccess = {
  baseKey: string;
  request: ModelAccessRequest;
  delegationId: string | null;
  recordId: string | null;
};

type PreparedBaseAuthority = {
  key: string;
  model: PublishedModel;
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

function delegationChainStatement(
  env: Bindings,
  delegationIds: readonly string[],
): D1PreparedStatement {
  const placeholders = delegationIds.map(() => "?").join(",");
  return env.DB.prepare(`
    WITH RECURSIVE chain(
      root_leaf_id,delegation_id,parent_delegation_id,remaining_redelegation_depth,
      principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
      created_by_type,created_by_id,delegation_revoked_at,delegation_expires_at,
      delegation_max_uses,delegation_consumed_at,chain_depth
    ) AS (
      SELECT
        d.id,d.id,d.parent_delegation_id,d.remaining_redelegation_depth,
        d.principal_type,d.principal_id,d.actor_type,d.actor_id,d.application_id,d.source_space_id,
        d.created_by_type,d.created_by_id,d.revoked_at,d.expires_at,d.max_uses,d.consumed_at,0
      FROM delegations d
      WHERE d.id IN (${placeholders})
      UNION ALL
      SELECT
        c.root_leaf_id,p.id,p.parent_delegation_id,p.remaining_redelegation_depth,
        p.principal_type,p.principal_id,p.actor_type,p.actor_id,p.application_id,p.source_space_id,
        p.created_by_type,p.created_by_id,p.revoked_at,p.expires_at,p.max_uses,p.consumed_at,c.chain_depth+1
      FROM chain c
      JOIN delegations p ON p.id=c.parent_delegation_id
      WHERE c.chain_depth < 3
    )
    SELECT
      c.*,
      ds.target_type AS delegation_target_type,
      ds.target_id AS delegation_target_id,
      ds.target_model_key AS delegation_target_model_key,
      ds.max_access AS delegation_max_access
    FROM chain c
    JOIN delegation_scopes ds ON ds.delegation_id=c.delegation_id
    ORDER BY c.root_leaf_id,c.chain_depth
  `).bind(...delegationIds);
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

function scopeContains(parent: DelegationSnapshotRow, child: DelegationSnapshotRow): boolean {
  if (permissionRank[parent.delegation_max_access] < permissionRank[child.delegation_max_access]) return false;
  if (parent.delegation_target_type === "space") {
    return parent.delegation_target_id === parent.source_space_id
      && child.source_space_id === parent.source_space_id;
  }
  if (parent.delegation_target_type === "model") {
    if (child.delegation_target_type === "model") {
      return child.delegation_target_id === parent.delegation_target_id;
    }
    return child.delegation_target_type === "record"
      && child.delegation_target_model_key === parent.delegation_target_id;
  }
  return child.delegation_target_type === "record"
    && child.delegation_target_id === parent.delegation_target_id
    && child.delegation_target_model_key === parent.delegation_target_model_key;
}

function expiryNarrows(parent: DelegationSnapshotRow, child: DelegationSnapshotRow): boolean {
  if (!parent.delegation_expires_at) return true;
  if (!child.delegation_expires_at) return false;
  return Date.parse(child.delegation_expires_at) <= Date.parse(parent.delegation_expires_at);
}

function validateDelegationChain(
  principal: Principal,
  spaceId: string,
  prepared: PreparedAccess,
  rows: readonly DelegationSnapshotRow[],
): {
  delegationId: string;
  delegationChain: string[];
  singleUseDelegationIds: string[];
} {
  if (!prepared.delegationId || !rows.length) {
    throw new ApiError("DELEGATION_INVALID", "Delegation chain was not found", 403);
  }

  const orderedLeafToRoot = [...rows].sort((left, right) => left.chain_depth - right.chain_depth);
  const leaf = orderedLeafToRoot[0]!;
  const actor = executionActor(principal);
  if (
    leaf.delegation_id !== prepared.delegationId
    || leaf.principal_type !== principal.type
    || leaf.principal_id !== principal.id
    || leaf.actor_type !== actor.type
    || leaf.actor_id !== actor.id
    || leaf.application_id !== principal.clientId
    || leaf.source_space_id !== spaceId
  ) {
    throw new ApiError("DELEGATION_INVALID", "Leaf Delegation does not match the verified Execution Context", 403);
  }

  if (new Set(orderedLeafToRoot.map((row) => row.delegation_id)).size !== orderedLeafToRoot.length) {
    throw new ApiError("DELEGATION_INVALID", "Delegation chain contains a cycle", 403);
  }

  for (let index = 0; index < orderedLeafToRoot.length; index += 1) {
    const row = orderedLeafToRoot[index]!;
    if (
      row.principal_type !== principal.type
      || row.principal_id !== principal.id
      || row.application_id !== principal.clientId
      || row.source_space_id !== spaceId
      || !delegationCurrent(row)
    ) {
      throw new ApiError(
        "DELEGATION_INVALID",
        "Delegation chain is revoked, expired, consumed or outside the verified Execution Context",
        403,
      );
    }
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

    const parent = orderedLeafToRoot[index + 1];
    if (!parent) {
      if (row.parent_delegation_id !== null) {
        throw new ApiError("DELEGATION_INVALID", "Delegation chain exceeds the supported depth or has a missing parent", 403);
      }
      continue;
    }
    if (
      row.parent_delegation_id !== parent.delegation_id
      || row.created_by_type !== parent.actor_type
      || row.created_by_id !== parent.actor_id
      || parent.remaining_redelegation_depth <= 0
      || row.remaining_redelegation_depth >= parent.remaining_redelegation_depth
      || !scopeContains(parent, row)
      || !expiryNarrows(parent, row)
    ) {
      throw new ApiError("DELEGATION_INVALID", "Delegation chain violates bounded re-delegation invariants", 403);
    }
  }

  const rootToLeaf = [...orderedLeafToRoot].reverse();
  return {
    delegationId: leaf.delegation_id,
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
  delegationRows: readonly DelegationSnapshotRow[],
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

export async function requireModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessDecision[]> {
  if (!requests.length) return [];

  const prepared = requests.map((request) => prepareAccess(principal, spaceId, request));
  const baseEntries = new Map<string, PreparedBaseAuthority>();
  const leafIds = new Set<string>();

  for (const entry of prepared) {
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
  const statements = [
    ...uniqueBases.map((entry) => entry.statement),
    ...(uniqueLeafIds.length ? [delegationChainStatement(env, uniqueLeafIds)] : []),
  ];
  const results = await env.DB.batch<Record<string, unknown>>(statements);

  const baseRows = new Map<string, BaseAuthoritySnapshotRow | null>();
  uniqueBases.forEach((entry, index) => {
    const row = (results[index]?.results ?? [])[0] as BaseAuthoritySnapshotRow | undefined;
    baseRows.set(entry.key, row ?? null);
  });

  const chainsByLeaf = new Map<string, DelegationSnapshotRow[]>();
  if (uniqueLeafIds.length) {
    const chainRows = (results[uniqueBases.length]?.results ?? []) as DelegationSnapshotRow[];
    for (const row of chainRows) {
      const rows = chainsByLeaf.get(row.root_leaf_id) ?? [];
      rows.push(row);
      chainsByLeaf.set(row.root_leaf_id, rows);
    }
  }

  return prepared.map((entry) => decisionFromSnapshots(
    principal,
    spaceId,
    entry,
    baseRows.get(entry.baseKey) ?? null,
    entry.delegationId ? chainsByLeaf.get(entry.delegationId) ?? [] : [],
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


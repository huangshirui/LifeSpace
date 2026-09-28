import type { Permission, SpaceRole } from "./authorization";
import type { Bindings, Principal } from "./env";
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

export type ModelAccessDecision = {
  applicationId: string;
  modelKey: string;
  required: ModelAccess;
  catalogAccess: ModelAccess;
  spaceAuthority: SpaceRole | "grant";
  actorPersonId: string | null;
  delegationId: string | null;
  singleUse: boolean;
};

type AuthoritySnapshotRow = {
  space_exists: number;
  catalog_access: ModelAccess | null;
  membership_role: SpaceRole | null;
  grant_permission: Permission | null;
  actor_person_id: string | null;
  delegation_id: string | null;
  delegation_revoked_at: string | null;
  delegation_expires_at: string | null;
  delegation_max_uses: number | null;
  delegation_consumed_at: string | null;
  delegation_target_type: "space" | "model" | "record" | null;
  delegation_target_id: string | null;
  delegation_target_model_key: string | null;
  delegation_max_access: Permission | null;
};

type PreparedAccess = {
  key: string;
  request: ModelAccessRequest;
  delegationId: string | null;
  recordId: string | null;
  statement: D1PreparedStatement;
};

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

function accessKey(
  principal: Principal,
  model: PublishedModel,
  required: ModelAccess,
  delegationId: string | null,
  recordId: string | null,
): string {
  return [
    principal.clientId,
    principal.type,
    principal.id,
    principal.actor?.type ?? principal.type,
    principal.actor?.id ?? principal.id,
    model.key,
    required,
    delegationId ?? "",
    recordId ?? "",
  ].join("\u001f");
}

function snapshotStatement(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  request: ModelAccessRequest,
  delegationId: string | null,
): D1PreparedStatement {
  const actorId = principal.actor?.id ?? "";
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
      ) AS actor_person_id,
      d.id AS delegation_id,
      d.revoked_at AS delegation_revoked_at,
      d.expires_at AS delegation_expires_at,
      d.max_uses AS delegation_max_uses,
      d.consumed_at AS delegation_consumed_at,
      ds.target_type AS delegation_target_type,
      ds.target_id AS delegation_target_id,
      ds.target_model_key AS delegation_target_model_key,
      ds.max_access AS delegation_max_access
    FROM (SELECT 1) base
    LEFT JOIN agent_delegations d
      ON d.id=?
      AND d.principal_user_id=?
      AND d.agent_id=?
      AND d.application_id=?
      AND d.source_space_id=?
    LEFT JOIN agent_delegation_scopes ds ON ds.delegation_id=d.id
    LIMIT 1
  `).bind(
    spaceId,
    principal.clientId,
    request.model.key,
    principal.type,
    spaceId,
    principal.id,
    spaceId,
    principal.type,
    principal.id,
    request.model.key,
    principal.type,
    spaceId,
    principal.id,
    delegationId,
    principal.id,
    actorId,
    principal.clientId,
    spaceId,
  );
}

function delegationCurrent(row: AuthoritySnapshotRow): boolean {
  if (!row.delegation_id || row.delegation_revoked_at || row.delegation_consumed_at) return false;
  if (!row.delegation_expires_at) return true;
  return Date.parse(row.delegation_expires_at) > Date.now();
}

function delegationScopeAllows(
  row: AuthoritySnapshotRow,
  spaceId: string,
  modelKey: string,
  recordId: string | null,
  required: ModelAccess,
): boolean {
  if (!row.delegation_max_access || permissionRank[row.delegation_max_access] < accessRank[required]) return false;
  if (row.delegation_target_type === "space") return row.delegation_target_id === spaceId;
  if (row.delegation_target_type === "model") return row.delegation_target_id === modelKey;
  if (row.delegation_target_type === "record") {
    return Boolean(recordId)
      && row.delegation_target_id === recordId
      && row.delegation_target_model_key === modelKey;
  }
  return false;
}

function decisionFromSnapshot(
  principal: Principal,
  spaceId: string,
  prepared: PreparedAccess,
  row: AuthoritySnapshotRow | null,
): ModelAccessDecision {
  const { request, delegationId, recordId } = prepared;
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

  let resolvedDelegationId: string | null = null;
  let singleUse = false;
  if (principal.actor) {
    if (!delegationId || !delegationCurrent(row)) {
      throw new ApiError(
        "DELEGATION_INVALID",
        "Delegation is missing, revoked, expired or already consumed",
        403,
      );
    }
    if (!delegationScopeAllows(row, spaceId, request.model.key, recordId, request.required)) {
      throw new ApiError(
        "DELEGATION_SCOPE_INSUFFICIENT",
        `Delegation scope does not allow ${request.required} access to this target`,
        403,
      );
    }
    resolvedDelegationId = row.delegation_id;
    singleUse = row.delegation_max_uses === 1;
  }

  return {
    applicationId: principal.clientId,
    modelKey: request.model.key,
    required: request.required,
    catalogAccess: row.catalog_access,
    spaceAuthority: membershipAllowed ? row.membership_role! : "grant",
    actorPersonId: row.actor_person_id,
    delegationId: resolvedDelegationId,
    singleUse,
  };
}

function prepareAccess(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  request: ModelAccessRequest,
): PreparedAccess {
  preflight(principal, request);
  const { delegationId, recordId } = selectorValues(principal, request.selector);
  return {
    key: accessKey(principal, request.model, request.required, delegationId, recordId),
    request,
    delegationId,
    recordId,
    statement: snapshotStatement(env, principal, spaceId, request, delegationId),
  };
}

export async function requireModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessDecision[]> {
  if (!requests.length) return [];

  const prepared = requests.map((request) => prepareAccess(env, principal, spaceId, request));
  const unique = new Map<string, PreparedAccess>();
  for (const entry of prepared) {
    if (!unique.has(entry.key)) unique.set(entry.key, entry);
  }
  const uniqueEntries = [...unique.values()];
  const results = await env.DB.batch<AuthoritySnapshotRow>(uniqueEntries.map((entry) => entry.statement));

  const decisions = new Map<string, ModelAccessDecision>();
  uniqueEntries.forEach((entry, index) => {
    const row = (results[index]?.results ?? [])[0] as AuthoritySnapshotRow | undefined;
    decisions.set(entry.key, decisionFromSnapshot(principal, spaceId, entry, row ?? null));
  });
  return prepared.map((entry) => decisions.get(entry.key)!);
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
  if (!decision.singleUse || !decision.delegationId) return;
  const consumedAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE agent_delegations
    SET consumed_at=?,consumed_by_change_id=NULL
    WHERE id=?
      AND max_uses=1
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`)
    .bind(consumedAt, decision.delegationId)
    .run();
  if (result.meta.changes !== 1) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "Single-use Delegation was consumed, revoked or expired before the read completed",
      403,
    );
  }
}

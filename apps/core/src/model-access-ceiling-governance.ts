import type { SpaceRole } from "./authorization";
import type { Bindings, Principal } from "./env";
import { resolveSpaceAuthorityModel } from "./external-model";
import { ApiError } from "./http";
import type { ModelAccessCeiling } from "./model-access-ceiling";
import type { PlatformAdminContext } from "./platform-admin-auth";

/** Internal control-plane callers only. Platform contexts must come from
 * requirePlatformAdminContext; the ordinary branch accepts a verified User. */
export type CeilingManager =
  | { kind: "space"; principal: Principal }
  | { kind: "platform"; admin: PlatformAdminContext };

type Target = { spaceId: string; userId: string };
type Snapshot = { manager_role: SpaceRole | null; target_role: SpaceRole | null; has_ceiling: number };
type CeilingRow = { model_key: string; max_access: ModelAccessCeiling; created_at: string; updated_at: string };
const actor = (manager: CeilingManager) => manager.kind === "space" ? manager.principal : manager.admin.actor;
const forbidden = () => new ApiError("FORBIDDEN", "Current Space role does not permit managing this model access ceiling", 403);

function validateManager(manager: CeilingManager, target: Target): void {
  const user = actor(manager);
  if (manager.kind === "space") {
    if (user.type !== "user" || user.actor || user.oauthExecution
      || !user.scopes.includes("spaces:manage") || user.id === target.userId) throw forbidden();
  } else if (user.type !== "user" || manager.admin.executor.type !== "service"
    || !manager.admin.executor.scopes.includes("spaces:manage")
    || user.clientId !== manager.admin.executor.clientId) throw forbidden();
}

async function targetSnapshot(env: Bindings, manager: CeilingManager, target: Target): Promise<Snapshot> {
  validateManager(manager,target);
  const row = await env.DB.prepare(`SELECT m.role manager_role,t.role target_role,
    EXISTS(SELECT 1 FROM model_access_ceilings c WHERE c.space_id=s.id
      AND c.entity_type='user' AND c.entity_id=?) has_ceiling
    FROM spaces s
    LEFT JOIN space_memberships m ON m.space_id=s.id AND m.user_id=? AND m.deleted_at IS NULL
    LEFT JOIN space_memberships t ON t.space_id=s.id AND t.user_id=? AND t.deleted_at IS NULL
    WHERE s.id=? AND s.deleted_at IS NULL`)
    .bind(target.userId,actor(manager).id,target.userId,target.spaceId).first<Snapshot>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND","Space not found",404);
  if (manager.kind==="space" && row.manager_role!=="owner"
    && !(row.manager_role==="admin" && (row.target_role==="editor" || row.target_role==="viewer"))) throw forbidden();
  if (row.target_role==="owner") throw forbidden();
  if (!row.target_role && !row.has_ceiling) throw new ApiError("MEMBER_NOT_FOUND","Member or retained restriction not found",404);
  return row;
}

export async function listModelAccessCeilings(env: Bindings, manager: CeilingManager, target: Target) {
  await targetSnapshot(env,manager,target);
  const rows = await env.DB.prepare(`SELECT c.model_key,c.max_access,c.created_at,c.updated_at
    FROM model_access_ceilings c JOIN spaces s ON s.id=c.space_id AND s.deleted_at IS NULL
    WHERE c.space_id=? AND c.entity_type='user' AND c.entity_id=? ORDER BY c.model_key`)
    .bind(target.spaceId,target.userId).all<CeilingRow>();
  return rows.results.map(row=>({modelKey:row.model_key,maxAccess:row.max_access,createdAt:row.created_at,updatedAt:row.updated_at}));
}

/** Set a sparse ceiling, or clear it with null (= inherit).
 * Audit snapshot and mutation are one atomic D1 batch. The audit INSERT
 * rechecks live membership/Space at commit; the mutation is conditional on
 * that exact audit row. A role change between preflight and commit fails closed.
 * No user-provided identity is used as operator authority. */
export async function changeModelAccessCeiling(
  env: Bindings, manager: CeilingManager, target: Target, modelKey: string,
  next: ModelAccessCeiling | null, requestId: string,
): Promise<void> {
  if (next !== null && !["none","read","write","manage"].includes(next)) {
    throw new ApiError("VALIDATION_ERROR","Invalid maxAccess",422);
  }
  if (!modelKey || modelKey.length>128) throw new ApiError("VALIDATION_ERROR","Invalid model key",422);
  const snapshot = await targetSnapshot(env,manager,target);
  // Only an active non-Owner member can receive a new ceiling. Retained
  // restrictions can still be cleared even if the model is retired/unbound.
  if (next!==null && !snapshot.target_role) throw new ApiError("MEMBER_NOT_FOUND","Active member required",404);
  if (next!==null) {
    const model = await resolveSpaceAuthorityModel(env,target.spaceId,modelKey);
    // External registration aliases (ext_*) must not persist a ceiling under
    // an address different from the canonical runtime Authority model key.
    if (!model || model.key !== modelKey) {
      throw new ApiError("MODEL_NOT_FOUND","Canonical published Space model key required",404);
    }
  }
  const user = actor(manager), platform = manager.kind==="platform" ? manager.admin : null;
  const auditId = `mca_${crypto.randomUUID().replaceAll("-","")}`;
  const now = new Date().toISOString();
  const audit = env.DB.prepare(`INSERT INTO model_access_ceiling_audit
    (id,space_id,entity_type,entity_id,model_key,previous_access,next_access,actor_user_id,application_id,executor_service_id,request_id,created_at)
    SELECT ?,s.id,'user',?,?,c.max_access,?,?,?,?,?,?
    FROM spaces s
    LEFT JOIN space_memberships m ON m.space_id=s.id AND m.user_id=? AND m.deleted_at IS NULL
    LEFT JOIN space_memberships t ON t.space_id=s.id AND t.user_id=? AND t.deleted_at IS NULL
    LEFT JOIN model_access_ceilings c ON c.space_id=s.id AND c.entity_type='user' AND c.entity_id=? AND c.model_key=?
    WHERE s.id=? AND s.deleted_at IS NULL AND COALESCE(t.role,'')!='owner'
      AND (?=1 OR m.role='owner' OR (m.role='admin' AND t.role IN ('editor','viewer')))
      AND (t.role IS NOT NULL OR (? IS NULL AND c.entity_id IS NOT NULL))`)
    .bind(auditId,target.userId,modelKey,next,user.id,user.clientId,platform?.executor.id??null,requestId,now,
      user.id,target.userId,target.userId,modelKey,target.spaceId,platform?1:0,next);
  const mutation = next===null
    ? env.DB.prepare(`DELETE FROM model_access_ceilings
        WHERE space_id=? AND entity_type='user' AND entity_id=? AND model_key=?
        AND EXISTS(SELECT 1 FROM model_access_ceiling_audit WHERE id=?)`)
      .bind(target.spaceId,target.userId,modelKey,auditId)
    : env.DB.prepare(`INSERT INTO model_access_ceilings
        (space_id,entity_type,entity_id,model_key,max_access,created_by_user_id,updated_by_user_id,created_at,updated_at)
        SELECT space_id,entity_type,entity_id,model_key,next_access,actor_user_id,actor_user_id,created_at,created_at
        FROM model_access_ceiling_audit WHERE id=?
        ON CONFLICT(space_id,entity_type,entity_id,model_key) DO UPDATE SET
          max_access=excluded.max_access,updated_by_user_id=excluded.updated_by_user_id,updated_at=excluded.updated_at`).bind(auditId);
  const statements = [audit,mutation];
  if (platform) {
    statements.push(env.DB.prepare(`INSERT INTO platform_admin_audit
      (id,actor_user_id,actor_application_id,actor_token_id,executor_principal_id,executor_application_id,executor_token_id,
       operation,target_type,target_id,summary_json,request_id,result,created_at)
      SELECT ?,actor_user_id,?,?,?,?,?,'model_access_ceiling.change','model_access_ceiling',id,
        json_object('spaceId',space_id,'userId',entity_id,'modelKey',model_key,'before',previous_access,'after',next_access),
        request_id,'success',created_at FROM model_access_ceiling_audit WHERE id=?`)
      .bind(`paa_${crypto.randomUUID().replaceAll("-","")}`,platform.actor.clientId,platform.actor.tokenId,
        platform.executor.id,platform.executor.clientId,platform.executor.tokenId,auditId));
  }
  const results = await env.DB.batch(statements);
  if (results[0]?.meta.changes!==1) throw forbidden();
}

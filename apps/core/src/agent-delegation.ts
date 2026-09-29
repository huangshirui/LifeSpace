import type { Hono } from "hono";
import { requireSpacePermission, type Permission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import type { ModelAccess } from "./model-definition";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type DelegationTargetType = "space" | "model" | "record";
type DelegationAccess = Permission;
type DelegationTargetInput = { type?: unknown; id?: unknown };
type DelegationScopeInput = { target?: unknown; maxAccess?: unknown };
type DelegationConstraintsInput = { maxUses?: unknown; expiresAt?: unknown };
type CreateDelegationBody = {
  agentId?: unknown;
  scope?: unknown;
  constraints?: unknown;
};

type DelegationRow = {
  id: string;
  actor_id: string;
  application_id: string;
  source_space_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  max_uses: number | null;
  consumed_at: string | null;
  target_type: DelegationTargetType;
  target_id: string;
  target_model_key: string | null;
  max_access: DelegationAccess;
};

type ParsedScope = {
  target: { type: DelegationTargetType; id: string };
  maxAccess: DelegationAccess;
};

type ParsedConstraints = {
  maxUses: 1 | null;
  expiresAt: string | null;
};

const delegationAccess = new Set<DelegationAccess>(["free_busy", "read", "write", "manage"]);
const modelAccess = new Set<ModelAccess>(["read", "write", "manage"]);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function requireDirectUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user" || principal.actor) {
    throw new ApiError("FORBIDDEN", "Delegation must be managed by the direct User Principal", 403);
  }
}

function parseExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("INVALID_REQUEST", "constraints.expiresAt must be an RFC 3339 date-time or null", 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/T/u.test(value)) {
    throw new ApiError("INVALID_REQUEST", "constraints.expiresAt must be an RFC 3339 date-time", 400);
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ApiError("INVALID_REQUEST", "constraints.expiresAt must be in the future", 400);
  }
  return parsed.toISOString();
}

function parseConstraints(value: unknown): ParsedConstraints {
  if (value === undefined || value === null) return { maxUses: null, expiresAt: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "constraints must be an object", 400);
  }
  const input = value as DelegationConstraintsInput;
  const unknown = Object.keys(input).find((key) => !["maxUses", "expiresAt"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported constraints field ${unknown}`, 400);
  if (input.maxUses !== undefined && input.maxUses !== 1) {
    throw new ApiError("INVALID_REQUEST", "constraints.maxUses currently supports only 1", 400);
  }
  return {
    maxUses: input.maxUses === 1 ? 1 : null,
    expiresAt: parseExpiry(input.expiresAt),
  };
}

function parseScope(value: unknown): ParsedScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "scope must be an object", 400);
  }
  const input = value as DelegationScopeInput;
  if (Object.keys(input).some((key) => !["target", "maxAccess"].includes(key))) {
    throw new ApiError("INVALID_REQUEST", "scope accepts only target and maxAccess", 400);
  }
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    throw new ApiError("INVALID_REQUEST", "scope.target must be an object", 400);
  }
  const target = input.target as DelegationTargetInput;
  if (Object.keys(target).some((key) => !["type", "id"].includes(key))) {
    throw new ApiError("INVALID_REQUEST", "scope.target accepts only type and id", 400);
  }
  if (!["space", "model", "record"].includes(String(target.type))) {
    throw new ApiError("INVALID_REQUEST", "scope.target.type must be space, model or record", 400);
  }
  if (typeof target.id !== "string" || !target.id.trim()) {
    throw new ApiError("INVALID_REQUEST", "scope.target.id is required", 400);
  }
  if (typeof input.maxAccess !== "string" || !delegationAccess.has(input.maxAccess as DelegationAccess)) {
    throw new ApiError("INVALID_REQUEST", "scope.maxAccess must be free_busy, read, write or manage", 400);
  }
  const type = target.type as DelegationTargetType;
  const targetId = target.id.trim();
  if (type === "space" && !/^spc_[A-Za-z0-9_-]+$/u.test(targetId)) {
    throw new ApiError("INVALID_REQUEST", "Space target must be a valid spc_* identifier", 400);
  }
  if (type === "record" && !/^rec_[A-Za-z0-9_-]+$/u.test(targetId)) {
    throw new ApiError("INVALID_REQUEST", "Record target must be a valid rec_* identifier", 400);
  }
  if (type === "model" && (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(targetId) || targetId.length > 100)) {
    throw new ApiError("INVALID_REQUEST", "Model target must be a valid modelKey", 400);
  }
  if (type !== "space" && input.maxAccess === "free_busy") {
    throw new ApiError("INVALID_REQUEST", "free_busy is supported only for Space-scoped Delegation", 400);
  }
  return {
    target: { type, id: targetId },
    maxAccess: input.maxAccess as DelegationAccess,
  };
}

function effectiveStatus(row: Pick<DelegationRow, "revoked_at" | "consumed_at" | "expires_at">): "active" | "revoked" | "consumed" | "expired" {
  if (row.revoked_at) return "revoked";
  if (row.consumed_at) return "consumed";
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

function dto(row: DelegationRow) {
  return {
    id: row.id,
    agentId: row.actor_id,
    applicationId: row.application_id,
    spaceId: row.source_space_id,
    scope: {
      target: { type: row.target_type, id: row.target_id },
      maxAccess: row.max_access,
    },
    constraints: {
      ...(row.max_uses === 1 ? { maxUses: 1 } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    },
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    effectiveStatus: effectiveStatus(row),
  };
}

async function validateScopeAuthority(
  env: Bindings,
  principal: Principal & { type: "user" },
  spaceId: string,
  scope: ParsedScope,
): Promise<string | null> {
  if (scope.target.type === "space") {
    if (scope.target.id !== spaceId) {
      throw new ApiError("INVALID_REQUEST", "Space Delegation target must equal the route Space", 400);
    }
    await requireSpacePermission(env, principal, spaceId, scope.maxAccess);
    return null;
  }

  if (scope.target.type === "model") {
    const model = await getRuntimeModel(env, scope.target.id);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${scope.target.id} not found`, 404);
    await requireModelAccess(env, principal, spaceId, model, scope.maxAccess as ModelAccess);
    return model.key;
  }

  const resource = await env.DB.prepare(`SELECT model_key FROM resource_records
    WHERE id=? AND space_id=? AND deleted_at IS NULL LIMIT 1`)
    .bind(scope.target.id, spaceId)
    .first<{ model_key: string }>();
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Record Delegation target was not found", 404);
  const model = await getRuntimeModel(env, resource.model_key);
  if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${resource.model_key} not found`, 404);
  await requireModelAccess(env, principal, spaceId, model, scope.maxAccess as ModelAccess, { recordId: scope.target.id });
  return model.key;
}

export function registerAgentDelegationRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/agent-delegations", async (context) => {
    const principal = context.get("principal");
    requireDirectUser(principal);
    const rows = await context.env.DB.prepare(`SELECT
        d.id,d.actor_id,d.application_id,d.source_space_id,d.created_at,d.expires_at,d.revoked_at,
        d.max_uses,d.consumed_at,
        s.target_type,s.target_id,s.target_model_key,s.max_access
      FROM delegations d
      JOIN delegation_scopes s ON s.delegation_id=d.id
      JOIN spaces sp ON sp.id=d.source_space_id AND sp.deleted_at IS NULL
      WHERE d.source_space_id=? AND d.principal_type='user' AND d.principal_id=?
        AND d.actor_type='agent' AND d.application_id=?
      ORDER BY d.created_at DESC,d.id`)
      .bind(context.req.param("spaceId"), principal.id, principal.clientId)
      .all<DelegationRow>();
    return context.json(success({ items: rows.results.map(dto) }));
  });

  app.post("/api/v1/spaces/:spaceId/agent-delegations", async (context) => {
    const principal = context.get("principal");
    requireDirectUser(principal);
    const body = await context.req.json<CreateDelegationBody>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
    }
    const unknown = Object.keys(body).find((key) => !["agentId", "scope", "constraints"].includes(key));
    if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported field ${unknown}`, 400);
    if (typeof body.agentId !== "string" || !/^agt_[A-Za-z0-9]+$/u.test(body.agentId)) {
      throw new ApiError("INVALID_REQUEST", "agentId must be a LifeSpace Agent ID", 400);
    }

    const scope = parseScope(body.scope);
    const constraints = parseConstraints(body.constraints);
    const spaceId = context.req.param("spaceId");
    const targetModelKey = await validateScopeAuthority(context.env, principal, spaceId, scope);

    const delegationId = id("dlg");
    const timestamp = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO delegations(
        id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
        created_by_type,created_by_id,created_at,expires_at,max_uses
      ) VALUES(?,'user',?,'agent',?,?,?,?, 'user',?,?,?,?)`).bind(
        delegationId,
        principal.id,
        body.agentId,
        principal.clientId,
        spaceId,
        principal.id,
        timestamp,
        constraints.expiresAt,
        constraints.maxUses,
      ),
      context.env.DB.prepare(`INSERT INTO delegation_scopes(
        delegation_id,target_type,target_id,target_model_key,max_access
      ) VALUES(?,?,?,?,?)`).bind(
        delegationId,
        scope.target.type,
        scope.target.id,
        targetModelKey,
        scope.maxAccess,
      ),
    ]);

    const row: DelegationRow = {
      id: delegationId,
      actor_id: body.agentId,
      application_id: principal.clientId,
      source_space_id: spaceId,
      created_at: timestamp,
      expires_at: constraints.expiresAt,
      revoked_at: null,
      max_uses: constraints.maxUses,
      consumed_at: null,
      target_type: scope.target.type,
      target_id: scope.target.id,
      target_model_key: targetModelKey,
      max_access: scope.maxAccess,
    };
    return context.json(success(dto(row)), 201);
  });

  app.delete("/api/v1/spaces/:spaceId/agent-delegations/:delegationId", async (context) => {
    const principal = context.get("principal");
    requireDirectUser(principal);
    const revokedAt = new Date().toISOString();
    const result = await context.env.DB.prepare(`UPDATE delegations SET revoked_at=?
      WHERE id=? AND source_space_id=? AND principal_type='user' AND principal_id=?
        AND actor_type='agent' AND application_id=?
        AND revoked_at IS NULL AND consumed_at IS NULL`)
      .bind(
        revokedAt,
        context.req.param("delegationId"),
        context.req.param("spaceId"),
        principal.id,
        principal.clientId,
      ).run();
    if (!result.meta.changes) throw new ApiError("DELEGATION_NOT_FOUND", "Active Delegation not found", 404);
    return context.body(null, 204);
  });
}

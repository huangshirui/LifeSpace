import type { Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import type { ModelAccess } from "./model-definition";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type DelegationModelInput = { modelKey?: unknown; maxAccess?: unknown };
type CreateDelegationBody = { agentId?: unknown; models?: unknown; expiresAt?: unknown };
type DelegationJoinRow = {
  id: string;
  agent_id: string;
  application_id: string;
  source_space_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  model_key: string;
  max_access: ModelAccess;
};

type DelegationDto = {
  id: string;
  agentId: string;
  applicationId: string;
  spaceId: string;
  models: Array<{ modelKey: string; maxAccess: ModelAccess }>;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

const modelAccess = new Set<ModelAccess>(["read", "write", "manage"]);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function requireDirectUser(principal: Principal): void {
  if (principal.type !== "user" || principal.actor) {
    throw new ApiError("FORBIDDEN", "Agent delegation must be managed by a direct user operation", 403);
  }
}

function parseExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) throw new ApiError("INVALID_REQUEST", "expiresAt must be an RFC 3339 date-time or null", 400);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/T/.test(value)) throw new ApiError("INVALID_REQUEST", "expiresAt must be an RFC 3339 date-time", 400);
  if (parsed.getTime() <= Date.now()) throw new ApiError("INVALID_REQUEST", "expiresAt must be in the future", 400);
  return parsed.toISOString();
}

function parseModels(value: unknown): Array<{ modelKey: string; maxAccess: ModelAccess }> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new ApiError("INVALID_REQUEST", "models must contain 1-20 model access entries", 400);
  }
  const result = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError("INVALID_REQUEST", "Each model delegation must be an object", 400);
    }
    const model = entry as DelegationModelInput;
    if (typeof model.modelKey !== "string" || !model.modelKey.trim()) {
      throw new ApiError("INVALID_REQUEST", "modelKey is required", 400);
    }
    if (typeof model.maxAccess !== "string" || !modelAccess.has(model.maxAccess as ModelAccess)) {
      throw new ApiError("INVALID_REQUEST", "maxAccess must be read, write or manage", 400);
    }
    return { modelKey: model.modelKey.trim(), maxAccess: model.maxAccess as ModelAccess };
  });
  if (new Set(result.map((entry) => entry.modelKey)).size !== result.length) {
    throw new ApiError("INVALID_REQUEST", "models must not contain duplicate modelKey values", 400);
  }
  return result;
}

function rowsToDelegations(rows: DelegationJoinRow[]): DelegationDto[] {
  const byId = new Map<string, DelegationDto>();
  for (const row of rows) {
    let delegation = byId.get(row.id);
    if (!delegation) {
      delegation = {
        id: row.id,
        agentId: row.agent_id,
        applicationId: row.application_id,
        spaceId: row.source_space_id,
        models: [],
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
      byId.set(row.id, delegation);
    }
    delegation.models.push({ modelKey: row.model_key, maxAccess: row.max_access });
  }
  return [...byId.values()];
}

export function registerAgentDelegationRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/agent-delegations", async (context) => {
    const principal = context.get("principal");
    requireDirectUser(principal);
    const rows = await context.env.DB.prepare(`SELECT
        d.id,d.agent_id,d.application_id,d.source_space_id,d.created_at,d.expires_at,d.revoked_at,
        m.model_key,m.max_access
      FROM agent_delegations d
      JOIN agent_delegation_models m ON m.delegation_id=d.id
      JOIN spaces s ON s.id=d.source_space_id AND s.deleted_at IS NULL
      WHERE d.source_space_id=? AND d.principal_user_id=? AND d.application_id=?
      ORDER BY d.created_at DESC,d.id,m.model_key`)
      .bind(context.req.param("spaceId"), principal.id, principal.clientId).all<DelegationJoinRow>();
    return context.json(success({ items: rowsToDelegations(rows.results) }));
  });

  app.post("/api/v1/spaces/:spaceId/agent-delegations", async (context) => {
    const principal = context.get("principal");
    requireDirectUser(principal);
    const body = await context.req.json<CreateDelegationBody>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
    }
    const unknown = Object.keys(body).find((key) => !["agentId", "models", "expiresAt"].includes(key));
    if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported field ${unknown}`, 400);
    if (typeof body.agentId !== "string" || !/^agt_[A-Za-z0-9]+$/.test(body.agentId)) {
      throw new ApiError("INVALID_REQUEST", "agentId must be a LifeSpace Agent ID", 400);
    }
    const models = parseModels(body.models);
    const expiresAt = parseExpiry(body.expiresAt);
    const spaceId = context.req.param("spaceId");

    for (const delegated of models) {
      const model = await getRuntimeModel(context.env, delegated.modelKey);
      if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${delegated.modelKey} not found`, 404);
      await requireModelAccess(context.env, principal, spaceId, model, delegated.maxAccess);
    }

    const delegationId = id("dlg");
    const timestamp = new Date().toISOString();
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO agent_delegations(
        id,principal_user_id,agent_id,application_id,source_space_id,created_by_user_id,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?)`).bind(
        delegationId,
        principal.id,
        body.agentId,
        principal.clientId,
        spaceId,
        principal.id,
        timestamp,
        expiresAt,
      ),
      ...models.map((delegated) => context.env.DB.prepare(`INSERT INTO agent_delegation_models(
        delegation_id,model_key,max_access
      ) VALUES(?,?,?)`).bind(delegationId, delegated.modelKey, delegated.maxAccess)),
    ]);

    return context.json(success({
      id: delegationId,
      agentId: body.agentId,
      applicationId: principal.clientId,
      spaceId,
      models,
      createdAt: timestamp,
      expiresAt,
      revokedAt: null,
    }), 201);
  });

  app.delete("/api/v1/spaces/:spaceId/agent-delegations/:delegationId", async (context) => {
    const principal = context.get("principal");
    requireDirectUser(principal);
    const revokedAt = new Date().toISOString();
    const result = await context.env.DB.prepare(`UPDATE agent_delegations SET revoked_at=?
      WHERE id=? AND source_space_id=? AND principal_user_id=? AND application_id=? AND revoked_at IS NULL`)
      .bind(
        revokedAt,
        context.req.param("delegationId"),
        context.req.param("spaceId"),
        principal.id,
        principal.clientId,
      ).run();
    if (!result.meta.changes) throw new ApiError("DELEGATION_NOT_FOUND", "Active delegation not found", 404);
    return context.body(null, 204);
  });
}

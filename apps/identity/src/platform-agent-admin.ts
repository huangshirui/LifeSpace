import type { Context, Hono } from "hono";
import type { Bindings, UserPrincipal, Variables } from "./env";
import { requirePlatformAdminActor } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type ApplicationRow = {
  id: string;
  trusted_backend: number;
  status: "active" | "disabled";
};

type AgentRow = {
  id: string;
  display_name: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  binding_status: "active" | "revoked";
  binding_created_at: string;
  binding_revoked_at: string | null;
};

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

function validApplicationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value);
}

function validAgentId(value: string): boolean {
  return /^agt_[A-Za-z0-9_-]+$/u.test(value);
}

function displayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 100 ? normalized : null;
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const value = await c.req.json<unknown>().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function loadApplication(env: Bindings, applicationId: string): Promise<ApplicationRow | null> {
  return env.DB.prepare("SELECT id,trusted_backend,status FROM applications WHERE id=?")
    .bind(applicationId).first<ApplicationRow>();
}

async function loadAgent(env: Bindings, applicationId: string, agentId: string): Promise<AgentRow | null> {
  return env.DB.prepare(`SELECT a.id,a.display_name,a.status,a.created_at,a.updated_at,
      aa.status binding_status,aa.created_at binding_created_at,aa.revoked_at binding_revoked_at
    FROM agents a
    JOIN agent_applications aa ON aa.agent_id=a.id
    WHERE a.id=? AND aa.application_id=?`)
    .bind(agentId, applicationId).first<AgentRow>();
}

function agentDto(row: AgentRow, applicationId: string) {
  return {
    id: row.id,
    applicationId,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    binding: {
      status: row.binding_status,
      createdAt: row.binding_created_at,
      revokedAt: row.binding_revoked_at,
    },
  };
}

function auditStatement(
  env: Bindings,
  actor: UserPrincipal,
  executorApplicationId: string,
  requestId: string,
  operation: string,
  targetId: string,
  summary: unknown,
) {
  return env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,executor_application_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id("paa"), actor.id, actor.clientId, actor.tokenId, executorApplicationId,
    operation, "agent", targetId, JSON.stringify(summary), requestId, "success", now(),
  );
}

async function admin(c: Context<AppEnv>): Promise<UserPrincipal | Response> {
  return requirePlatformAdminActor(c, "applications:manage");
}

export function registerPlatformAgentAdminRoutes(app: App): void {
  app.get("/internal/v1/platform-admin/applications/:applicationId/agents", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    if (!validApplicationId(applicationId)) return c.json(fail("VALIDATION_ERROR", "applicationId is invalid", c.get("requestId")), 422);
    if (!await loadApplication(c.env, applicationId)) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`SELECT a.id,a.display_name,a.status,a.created_at,a.updated_at,
        aa.status binding_status,aa.created_at binding_created_at,aa.revoked_at binding_revoked_at
      FROM agents a
      JOIN agent_applications aa ON aa.agent_id=a.id
      WHERE aa.application_id=?
      ORDER BY aa.created_at DESC,a.id`).bind(applicationId).all<AgentRow>();
    return c.json(ok(rows.results.map((row) => agentDto(row, applicationId))));
  });

  app.post("/internal/v1/platform-admin/applications/:applicationId/agents", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    if (!validApplicationId(applicationId)) return c.json(fail("VALIDATION_ERROR", "applicationId is invalid", c.get("requestId")), 422);
    const application = await loadApplication(c.env, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.status !== "active" || application.trusted_backend !== 1) {
      return c.json(fail("APPLICATION_NOT_TRUSTED", "Agent identity requires an active trusted-backend Application", c.get("requestId")), 409);
    }
    const body = await jsonBody(c);
    if (!body || Object.keys(body).some((key) => key !== "displayName")) {
      return c.json(fail("INVALID_REQUEST", "Request may contain only displayName", c.get("requestId")), 400);
    }
    const name = displayName(body.displayName);
    if (!name) return c.json(fail("VALIDATION_ERROR", "displayName must contain 1-100 characters", c.get("requestId")), 422);

    const agentId = id("agt");
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO agents(id,display_name,status,created_at,updated_at) VALUES(?,?,'active',?,?)")
        .bind(agentId, name, timestamp, timestamp),
      c.env.DB.prepare("INSERT INTO agent_applications(agent_id,application_id,status,created_at,revoked_at) VALUES(?,?,'active',?,NULL)")
        .bind(agentId, applicationId, timestamp),
      auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "agent.create", agentId, {
        applicationId,
        displayName: name,
        status: "active",
        authorityGranted: false,
        delegationCreated: false,
      }),
    ]);
    const created = await loadAgent(c.env, applicationId, agentId);
    if (!created) throw new Error("Agent missing after creation");
    return c.json(ok(agentDto(created, applicationId)), 201);
  });

  app.patch("/internal/v1/platform-admin/applications/:applicationId/agents/:agentId", async (c) => {
    const actor = await admin(c);
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const agentId = c.req.param("agentId");
    if (!validApplicationId(applicationId) || !validAgentId(agentId)) {
      return c.json(fail("VALIDATION_ERROR", "Application or Agent id is invalid", c.get("requestId")), 422);
    }
    const application = await loadApplication(c.env, applicationId);
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const previous = await loadAgent(c.env, applicationId, agentId);
    if (!previous) return c.json(fail("AGENT_NOT_FOUND", "Agent is not bound to this Application", c.get("requestId")), 404);
    if (previous.binding_status !== "active" || previous.binding_revoked_at) {
      return c.json(fail("AGENT_BINDING_REVOKED", "Revoked Agent binding cannot be modified through this lifecycle", c.get("requestId")), 409);
    }
    const body = await jsonBody(c);
    const keys = body ? Object.keys(body) : [];
    if (!body || !keys.length || keys.some((key) => !["displayName", "status"].includes(key))) {
      return c.json(fail("INVALID_REQUEST", "Only displayName and status may be updated", c.get("requestId")), 400);
    }

    const name = body.displayName === undefined ? previous.display_name : displayName(body.displayName);
    if (!name) return c.json(fail("VALIDATION_ERROR", "displayName must contain 1-100 characters", c.get("requestId")), 422);
    const status = body.status === undefined ? previous.status : body.status;
    if (status !== "active" && status !== "disabled") {
      return c.json(fail("VALIDATION_ERROR", "status must be active or disabled", c.get("requestId")), 422);
    }
    if (status === "active" && (application.status !== "active" || application.trusted_backend !== 1)) {
      return c.json(fail("APPLICATION_NOT_TRUSTED", "Disabled or non-trusted Application cannot reactivate an Agent", c.get("requestId")), 409);
    }

    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE agents SET display_name=?,status=?,updated_at=? WHERE id=?")
        .bind(name, status, timestamp, agentId),
      auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "agent.update", agentId, {
        applicationId,
        displayName: name,
        status,
        globalStatus: true,
      }),
    ]);
    const updated = await loadAgent(c.env, applicationId, agentId);
    if (!updated) throw new Error("Agent missing after update");
    return c.json(ok(agentDto(updated, applicationId)));
  });
}

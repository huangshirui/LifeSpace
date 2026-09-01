import type { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type AgentBody = { displayName?: unknown };
type AgentTokenBody = { subjectId?: unknown; agentId?: unknown; scopes?: unknown };

type AgentRow = {
  id: string;
  display_name: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

const TOKEN_ISSUER = "lifespace-identity";
const TOKEN_AUDIENCES = ["lifespace-core", "lifespace-identity"] as const;
const MAX_DELEGATED_AGENT_TOKEN_TTL_SECONDS = 900;
const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function name(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 100 ? normalized : null;
}

function scopes(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 100)) return null;
  const normalized = value.map((entry) => (entry as string).trim());
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function agentDto(row: AgentRow) {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function registerAgentAuthenticationRoutes(app: App): void {
  app.get("/internal/v1/agents", async (c) => {
    const applicationId = c.get("currentApplicationId");
    const rows = await c.env.DB.prepare(`SELECT a.id,a.display_name,a.status,a.created_at,a.updated_at
      FROM agents a
      JOIN agent_applications aa ON aa.agent_id=a.id
      WHERE aa.application_id=? AND aa.status='active' AND aa.revoked_at IS NULL
      ORDER BY a.created_at,a.id`)
      .bind(applicationId).all<AgentRow>();
    return c.json(ok({ items: rows.results.map(agentDto) }));
  });

  app.post("/internal/v1/agents", async (c) => {
    const body = (await c.req.json<AgentBody>().catch(() => ({}))) as AgentBody;
    if (Object.keys(body as Record<string, unknown>).some((key) => key !== "displayName")) {
      return c.json(fail("INVALID_REQUEST", "Request may contain only displayName", c.get("requestId")), 400);
    }
    const displayName = name(body.displayName);
    if (!displayName) {
      return c.json(fail("VALIDATION_ERROR", "displayName must contain 1-100 characters", c.get("requestId")), 422);
    }

    const agentId = id("agt");
    const applicationId = c.get("currentApplicationId");
    const timestamp = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO agents(id,display_name,status,created_at,updated_at)
        VALUES(?,?,'active',?,?)`).bind(agentId, displayName, timestamp, timestamp),
      c.env.DB.prepare(`INSERT INTO agent_applications(agent_id,application_id,status,created_at)
        VALUES(?,?,'active',?)`).bind(agentId, applicationId, timestamp),
    ]);
    return c.json(ok({ id: agentId, displayName, status: "active", createdAt: timestamp, updatedAt: timestamp }), 201);
  });

  app.post("/internal/v1/agent-tokens", async (c) => {
    const body = (await c.req.json<AgentTokenBody>().catch(() => ({}))) as AgentTokenBody;
    const unknownKey = Object.keys(body as Record<string, unknown>).find((key) => !["subjectId", "agentId", "scopes"].includes(key));
    if (unknownKey) {
      return c.json(fail("INVALID_REQUEST", `Unsupported field ${unknownKey}`, c.get("requestId")), 400);
    }
    if (typeof body.subjectId !== "string" || !body.subjectId.startsWith("usr_")) {
      return c.json(fail("VALIDATION_ERROR", "subjectId must be a LifeSpace user ID", c.get("requestId")), 422);
    }
    if (typeof body.agentId !== "string" || !body.agentId.startsWith("agt_")) {
      return c.json(fail("VALIDATION_ERROR", "agentId must be a LifeSpace Agent ID", c.get("requestId")), 422);
    }
    const requested = scopes(body.scopes);
    if (!requested) {
      return c.json(fail("VALIDATION_ERROR", "scopes must be a unique string array", c.get("requestId")), 422);
    }

    const user = await c.env.DB.prepare("SELECT status FROM users WHERE id=?")
      .bind(body.subjectId).first<{ status: string }>();
    if (!user || user.status !== "active") {
      return c.json(fail("FORBIDDEN", "User is not active", c.get("requestId")), 403);
    }

    const applicationId = c.get("currentApplicationId");
    const agent = await c.env.DB.prepare(`SELECT a.status
      FROM agents a JOIN agent_applications aa ON aa.agent_id=a.id
      WHERE a.id=? AND aa.application_id=? AND aa.status='active' AND aa.revoked_at IS NULL`)
      .bind(body.agentId, applicationId).first<{ status: string }>();
    if (!agent || agent.status !== "active") {
      return c.json(fail("FORBIDDEN", "Agent is not active for this application", c.get("requestId")), 403);
    }

    const allowed = c.get("currentApplicationScopes");
    if (requested.some((scope) => !allowed.includes(scope))) {
      return c.json(fail("FORBIDDEN", "Requested scope is not allowed for this application", c.get("requestId")), 403);
    }
    if (!c.env.TOKEN_PRIVATE_KEY) {
      return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token signing key is not configured", c.get("requestId")), 500);
    }

    const tokenTtlSeconds = Math.min(c.get("currentApplicationTokenTtlSeconds"), MAX_DELEGATED_AGENT_TOKEN_TTL_SECONDS);
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + tokenTtlSeconds;
    const jti = id("tok");
    const token = await sign({
      iss: TOKEN_ISSUER,
      aud: [...TOKEN_AUDIENCES],
      sub: body.subjectId,
      azp: applicationId,
      principal_type: "user",
      actor_type: "agent",
      actor_id: body.agentId,
      purpose: "delegated_agent",
      scope: requested.join(" "),
      iat,
      exp,
      jti,
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");

    return c.json(ok({
      accessToken: token,
      tokenType: "Bearer",
      expiresIn: tokenTtlSeconds,
      scope: requested.join(" "),
      principalId: body.subjectId,
      actor: { type: "agent", id: body.agentId },
      applicationId,
    }));
  });
}

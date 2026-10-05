import type { Context, Hono } from "hono";
import type { Bindings, UserPrincipal, Variables } from "./env";
import { measurePerformancePhase } from "./performance-timing";
import { requirePlatformAdminActor } from "./platform-admin-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type AgentBindingRow = {
  agentId: string;
  displayName: string;
  agentStatus: "active" | "disabled";
  bindingStatus: "active" | "revoked";
  bindingRevokedAt: string | null;
  applicationId: string;
  applicationStatus: "active" | "disabled";
  trustedBackend: number;
  allowedScopes: string;
};

type AgentCredentialRow = {
  id: string;
  agent_id: string;
  application_id: string;
  display_prefix: string;
  last_four: string;
  label: string;
  scopes: string;
  audience: string;
  status: "active" | "revoked";
  expires_at: string | null;
  created_at: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
};

const TOKEN_HASH_VERSION = 1;
const AGENT_TOKEN_PREFIX = "lsp_agt_";
const TOKEN_AUDIENCE = "lifespace-core";
const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqualDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  return constantTimeEqualDigest(await sha256(left), await sha256(right));
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const raw = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return `${AGENT_TOKEN_PREFIX}${raw}`;
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !scope.trim() || scope.length > 100)) {
    throw new Error("scopes must be an array of non-empty strings");
  }
  const result = value.map((scope) => (scope as string).trim());
  if (new Set(result).size !== result.length) throw new Error("scopes must not contain duplicates");
  return result;
}

function scopeSubset(requested: string[], ceiling: string[]): boolean {
  return requested.every((scope) => ceiling.includes(scope));
}

function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new Error("label must contain 1-100 characters");
  return value.trim();
}

function futureInstant(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    throw new Error(`${field} must be a future RFC 3339 UTC instant or null`);
  }
  return value;
}

async function body(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const value = await c.req.json<unknown>().catch(() => null);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function dto(row: AgentCredentialRow) {
  return {
    id: row.id,
    agentId: row.agent_id,
    applicationId: row.application_id,
    displayPrefix: row.display_prefix,
    lastFour: row.last_four,
    label: row.label,
    scopes: parseJsonArray(row.scopes),
    audience: row.audience,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id,
  };
}

async function binding(env: Bindings, applicationId: string, agentId: string): Promise<AgentBindingRow | null> {
  return env.DB.prepare(`SELECT a.id agentId,a.display_name displayName,a.status agentStatus,
      aa.status bindingStatus,aa.revoked_at bindingRevokedAt,
      app.id applicationId,app.status applicationStatus,app.trusted_backend trustedBackend,app.allowed_scopes allowedScopes
    FROM agents a
    JOIN agent_applications aa ON aa.agent_id=a.id
    JOIN applications app ON app.id=aa.application_id
    WHERE a.id=? AND aa.application_id=?`)
    .bind(agentId, applicationId).first<AgentBindingRow>();
}

function activeBinding(row: AgentBindingRow | null): row is AgentBindingRow {
  return Boolean(row)
    && row!.agentStatus === "active"
    && row!.bindingStatus === "active"
    && !row!.bindingRevokedAt
    && row!.applicationStatus === "active"
    && row!.trustedBackend === 1;
}

async function credential(env: Bindings, applicationId: string, agentId: string, credentialId: string): Promise<AgentCredentialRow | null> {
  return env.DB.prepare(`SELECT id,agent_id,application_id,display_prefix,last_four,label,scopes,audience,status,expires_at,
      created_at,created_by_user_id,last_used_at,revoked_at,revoked_by_user_id
    FROM agent_api_credentials WHERE id=? AND application_id=? AND agent_id=?`)
    .bind(credentialId, applicationId, agentId).first<AgentCredentialRow>();
}

async function listCredentials(env: Bindings, applicationId: string, agentId: string): Promise<AgentCredentialRow[]> {
  const rows = await env.DB.prepare(`SELECT id,agent_id,application_id,display_prefix,last_four,label,scopes,audience,status,expires_at,
      created_at,created_by_user_id,last_used_at,revoked_at,revoked_by_user_id
    FROM agent_api_credentials WHERE application_id=? AND agent_id=? ORDER BY created_at DESC,id DESC`)
    .bind(applicationId, agentId).all<AgentCredentialRow>();
  return rows.results;
}

async function createCredential(
  c: Context<AppEnv>,
  applicationId: string,
  agentId: string,
  allowedScopes: string[],
  createdByUserId: string | null,
): Promise<Response> {
  const current = await binding(c.env, applicationId, agentId);
  if (!current) return c.json(fail("AGENT_NOT_FOUND", "Agent is not bound to this Application", c.get("requestId")), 404);
  if (!activeBinding(current)) return c.json(fail("AGENT_NOT_ACTIVE", "Agent and Application binding must be active", c.get("requestId")), 409);
  const input = await body(c);
  if (!input || Object.keys(input).some((key) => !["label", "scopes", "expiresAt"].includes(key))) {
    return c.json(fail("INVALID_REQUEST", "Request may contain only label, scopes and expiresAt", c.get("requestId")), 400);
  }
  try {
    const credentialLabel = label(input.label);
    const scopes = parseScopes(input.scopes ?? []);
    if (!scopeSubset(scopes, allowedScopes) || !scopeSubset(scopes, parseJsonArray(current.allowedScopes))) {
      return c.json(fail("FORBIDDEN", "Agent credential scopes exceed the current Application scope ceiling", c.get("requestId")), 403);
    }
    const expiresAt = futureInstant(input.expiresAt, "expiresAt");
    const plaintext = randomSecret();
    const timestamp = now();
    const credentialId = id("agc");
    await c.env.DB.prepare(`INSERT INTO agent_api_credentials(
      id,agent_id,application_id,token_hash_version,token_hash,display_prefix,last_four,label,scopes,audience,status,
      expires_at,created_at,created_by_user_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?, 'active',?,?,?)`).bind(
      credentialId,
      agentId,
      applicationId,
      TOKEN_HASH_VERSION,
      await sha256(plaintext),
      plaintext.slice(0, 16),
      plaintext.slice(-4),
      credentialLabel,
      JSON.stringify(scopes),
      TOKEN_AUDIENCE,
      expiresAt,
      timestamp,
      createdByUserId,
    ).run();
    const row = await credential(c.env, applicationId, agentId, credentialId);
    if (!row) throw new Error("Agent API credential metadata missing after creation");
    return c.json(ok({ ...dto(row), token: plaintext }), 201);
  } catch (error) {
    return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid Agent API credential", c.get("requestId")), 422);
  }
}

async function updateCredential(
  c: Context<AppEnv>,
  applicationId: string,
  agentId: string,
  allowedScopes: string[],
  credentialId: string,
): Promise<Response> {
  const row = await credential(c.env, applicationId, agentId, credentialId);
  if (!row || row.status !== "active" || row.revoked_at) {
    return c.json(fail("AGENT_CREDENTIAL_NOT_FOUND", "Active Agent API credential not found", c.get("requestId")), 404);
  }
  const input = await body(c);
  const keys = input ? Object.keys(input) : [];
  if (!input || !keys.length || keys.some((key) => !["label", "scopes", "expiresAt"].includes(key))) {
    return c.json(fail("INVALID_REQUEST", "Only label, scopes and expiresAt may be updated", c.get("requestId")), 400);
  }
  try {
    const nextLabel = input.label === undefined ? row.label : label(input.label);
    const previousScopes = parseJsonArray(row.scopes);
    const nextScopes = input.scopes === undefined ? previousScopes : parseScopes(input.scopes);
    if (!scopeSubset(nextScopes, previousScopes) || !scopeSubset(nextScopes, allowedScopes)) {
      throw new Error("Agent credential scopes may only be reduced inside the current Application ceiling");
    }
    let expiresAt = row.expires_at;
    if (input.expiresAt !== undefined) {
      const nextExpiry = futureInstant(input.expiresAt, "expiresAt");
      if (row.expires_at && (!nextExpiry || Date.parse(nextExpiry) > Date.parse(row.expires_at))) {
        throw new Error("Agent credential expiry may only be shortened");
      }
      expiresAt = nextExpiry;
    }
    await c.env.DB.prepare(`UPDATE agent_api_credentials SET label=?,scopes=?,expires_at=?
      WHERE id=? AND application_id=? AND agent_id=? AND status='active' AND revoked_at IS NULL`)
      .bind(nextLabel, JSON.stringify(nextScopes), expiresAt, credentialId, applicationId, agentId).run();
    const updated = await credential(c.env, applicationId, agentId, credentialId);
    if (!updated) throw new Error("Agent API credential missing after update");
    return c.json(ok(dto(updated)));
  } catch (error) {
    return c.json(fail("VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid Agent API credential update", c.get("requestId")), 422);
  }
}

async function revokeCredential(
  c: Context<AppEnv>,
  applicationId: string,
  agentId: string,
  credentialId: string,
  revokedByUserId: string | null,
): Promise<Response> {
  const result = await c.env.DB.prepare(`UPDATE agent_api_credentials
    SET status='revoked',revoked_at=?,revoked_by_user_id=?
    WHERE id=? AND application_id=? AND agent_id=? AND status='active' AND revoked_at IS NULL`)
    .bind(now(), revokedByUserId, credentialId, applicationId, agentId).run();
  if (!result.meta.changes) return c.json(fail("AGENT_CREDENTIAL_NOT_FOUND", "Active Agent API credential not found", c.get("requestId")), 404);
  return c.body(null, 204);
}

function deferOperationalWrite(c: Context<AppEnv>, operation: Promise<unknown>): void {
  const guarded = operation.catch(() => undefined);
  try { c.executionCtx.waitUntil(guarded); }
  catch { void guarded; }
}

function auditStatement(
  env: Bindings,
  actor: UserPrincipal,
  executorApplicationId: string,
  requestId: string,
  operation: string,
  credentialId: string,
  summary: unknown,
) {
  return env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,executor_application_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id("paa"), actor.id, actor.clientId, actor.tokenId, executorApplicationId,
    operation, "agent_api_credential", credentialId, JSON.stringify(summary), requestId, "success", now(),
  );
}

export function registerAgentApiCredentialRoutes(app: App): void {
  // Trusted Application lifecycle. /internal/* application authentication is supplied by app.ts middleware.
  app.get("/internal/v1/agents/:agentId/api-credentials", async (c) => {
    const applicationId = c.get("currentApplicationId");
    const agentId = c.req.param("agentId");
    if (!await binding(c.env, applicationId, agentId)) return c.json(fail("AGENT_NOT_FOUND", "Agent is not bound to this Application", c.get("requestId")), 404);
    return c.json(ok((await listCredentials(c.env, applicationId, agentId)).map(dto)));
  });

  app.post("/internal/v1/agents/:agentId/api-credentials", async (c) => createCredential(
    c,
    c.get("currentApplicationId"),
    c.req.param("agentId"),
    c.get("currentApplicationScopes"),
    null,
  ));

  app.patch("/internal/v1/agents/:agentId/api-credentials/:credentialId", async (c) => updateCredential(
    c,
    c.get("currentApplicationId"),
    c.req.param("agentId"),
    c.get("currentApplicationScopes"),
    c.req.param("credentialId"),
  ));

  app.delete("/internal/v1/agents/:agentId/api-credentials/:credentialId", async (c) => revokeCredential(
    c,
    c.get("currentApplicationId"),
    c.req.param("agentId"),
    c.req.param("credentialId"),
    null,
  ));

  // Platform Admin lifecycle for Console/operator issuance and rotation.
  app.get("/internal/v1/platform-admin/applications/:applicationId/agents/:agentId/api-credentials", async (c) => {
    const actor = await requirePlatformAdminActor(c, "applications:manage");
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const agentId = c.req.param("agentId");
    if (!await binding(c.env, applicationId, agentId)) return c.json(fail("AGENT_NOT_FOUND", "Agent is not bound to this Application", c.get("requestId")), 404);
    return c.json(ok((await listCredentials(c.env, applicationId, agentId)).map(dto)));
  });

  app.post("/internal/v1/platform-admin/applications/:applicationId/agents/:agentId/api-credentials", async (c) => {
    const actor = await requirePlatformAdminActor(c, "applications:manage");
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const agentId = c.req.param("agentId");
    const current = await binding(c.env, applicationId, agentId);
    if (!current) return c.json(fail("AGENT_NOT_FOUND", "Agent is not bound to this Application", c.get("requestId")), 404);
    const response = await createCredential(c, applicationId, agentId, parseJsonArray(current.allowedScopes), actor.id);
    if (response.status === 201) {
      const payload = await response.clone().json<{ data?: { id?: string; label?: string; scopes?: string[]; expiresAt?: string | null } }>().catch(() => null);
      const credentialId = payload?.data?.id;
      if (credentialId) await auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "agent.api_credential.create", credentialId, {
        applicationId, agentId, label: payload?.data?.label, scopes: payload?.data?.scopes, expiresAt: payload?.data?.expiresAt ?? null, authorityGranted: false,
      }).run();
    }
    return response;
  });

  app.patch("/internal/v1/platform-admin/applications/:applicationId/agents/:agentId/api-credentials/:credentialId", async (c) => {
    const actor = await requirePlatformAdminActor(c, "applications:manage");
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const agentId = c.req.param("agentId");
    const credentialId = c.req.param("credentialId");
    const current = await binding(c.env, applicationId, agentId);
    if (!current) return c.json(fail("AGENT_NOT_FOUND", "Agent is not bound to this Application", c.get("requestId")), 404);
    const response = await updateCredential(c, applicationId, agentId, parseJsonArray(current.allowedScopes), credentialId);
    if (response.status === 200) await auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "agent.api_credential.update", credentialId, {
      applicationId, agentId, authorityGranted: false,
    }).run();
    return response;
  });

  app.delete("/internal/v1/platform-admin/applications/:applicationId/agents/:agentId/api-credentials/:credentialId", async (c) => {
    const actor = await requirePlatformAdminActor(c, "applications:manage");
    if (actor instanceof Response) return actor;
    const applicationId = c.req.param("applicationId");
    const agentId = c.req.param("agentId");
    const credentialId = c.req.param("credentialId");
    const response = await revokeCredential(c, applicationId, agentId, credentialId, actor.id);
    if (response.status === 204) await auditStatement(c.env, actor, c.get("currentApplicationId"), c.get("requestId"), "agent.api_credential.revoke", credentialId, {
      applicationId, agentId,
    }).run();
    return response;
  });

  // Core-only opaque credential introspection through the existing Service Binding.
  app.post("/introspection/v1/agent-credentials", async (c) => {
    const sharedSecret = c.req.header("x-lifespace-internal-secret") ?? "";
    if (!c.env.CORE_IDENTITY_SHARED_SECRET || !sharedSecret || !await constantTimeEqual(sharedSecret, c.env.CORE_IDENTITY_SHARED_SECRET)) {
      return c.json(fail("UNAUTHORIZED", "Internal service authentication is required", c.get("requestId")), 401);
    }
    const authorization = c.req.header("authorization");
    const plaintext = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!plaintext.startsWith(AGENT_TOKEN_PREFIX) || plaintext.length < 40) return c.json(ok({ active: false }));
    const tokenHash = await sha256(plaintext);
    const row = await measurePerformancePhase(c, "identity.agent_credential_lookup", () =>
      c.env.DB.prepare(`SELECT ac.id tokenId,ac.agent_id agentId,ac.application_id applicationId,ac.scopes,ac.audience,
          ac.status credentialStatus,ac.expires_at expiresAt,ac.revoked_at revokedAt,
          a.display_name displayName,a.status agentStatus,aa.status bindingStatus,aa.revoked_at bindingRevokedAt,
          app.allowed_scopes allowedScopes,app.status applicationStatus,app.trusted_backend trustedBackend
        FROM agent_api_credentials ac
        JOIN agents a ON a.id=ac.agent_id
        JOIN agent_applications aa ON aa.agent_id=ac.agent_id AND aa.application_id=ac.application_id
        JOIN applications app ON app.id=ac.application_id
        WHERE ac.token_hash_version=? AND ac.token_hash=?`)
        .bind(TOKEN_HASH_VERSION, tokenHash).first<{
          tokenId: string; agentId: string; applicationId: string; scopes: string; audience: string;
          credentialStatus: string; expiresAt: string | null; revokedAt: string | null;
          displayName: string; agentStatus: string; bindingStatus: string; bindingRevokedAt: string | null;
          allowedScopes: string; applicationStatus: string; trustedBackend: number;
        }>(),
    );
    if (!row
      || row.credentialStatus !== "active"
      || row.revokedAt
      || row.agentStatus !== "active"
      || row.bindingStatus !== "active"
      || row.bindingRevokedAt
      || row.applicationStatus !== "active"
      || row.trustedBackend !== 1
      || row.audience !== TOKEN_AUDIENCE
      || (row.expiresAt && Date.parse(row.expiresAt) <= Date.now())) {
      return c.json(ok({ active: false }));
    }
    const scopes = parseJsonArray(row.scopes);
    if (!scopeSubset(scopes, parseJsonArray(row.allowedScopes))) return c.json(ok({ active: false }));
    deferOperationalWrite(c, c.env.DB.prepare("UPDATE agent_api_credentials SET last_used_at=? WHERE id=?").bind(now(), row.tokenId).run());
    return c.json(ok({
      active: true,
      principal: {
        type: "agent",
        id: row.agentId,
        displayName: row.displayName,
        clientId: row.applicationId,
        scopes,
        tokenId: row.tokenId,
        purpose: "agent_api",
      },
      audience: row.audience,
    }));
  });
}

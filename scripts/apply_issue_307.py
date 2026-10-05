from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path):
    return (ROOT / path).read_text()

def write(path, content):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)

def replace_once(path, old, new):
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

# ---------------------------------------------------------------------------
# Identity schema + Agent API credential lifecycle
# ---------------------------------------------------------------------------
write("apps/identity/migrations/0009_agent_api_credentials.sql", r'''PRAGMA foreign_keys = ON;

CREATE TABLE agent_api_credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  application_id TEXT NOT NULL,
  token_hash_version INTEGER NOT NULL DEFAULT 1 CHECK (token_hash_version = 1),
  token_hash TEXT NOT NULL UNIQUE,
  display_prefix TEXT NOT NULL,
  last_four TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 100),
  scopes TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'lifespace-core' CHECK (audience = 'lifespace-core'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id),
  FOREIGN KEY(agent_id, application_id) REFERENCES agent_applications(agent_id, application_id)
);

CREATE INDEX idx_agent_api_credentials_binding
  ON agent_api_credentials(agent_id, application_id, status, revoked_at, expires_at);
CREATE INDEX idx_agent_api_credentials_lookup
  ON agent_api_credentials(token_hash, status, revoked_at);

UPDATE schema_metadata SET value='9' WHERE key='schema_version';
''')

write("apps/identity/src/agent-api-credential.ts", r'''import type { Context, Hono } from "hono";
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
''')

replace_once(
    "apps/identity/src/app.ts",
    'import { registerAgentAuthenticationRoutes } from "./agent-auth";\n',
    'import { registerAgentAuthenticationRoutes } from "./agent-auth";\nimport { registerAgentApiCredentialRoutes } from "./agent-api-credential";\n',
)
replace_once(
    "apps/identity/src/app.ts",
    '  registerAgentAuthenticationRoutes(app);\n',
    '  registerAgentAuthenticationRoutes(app);\n  registerAgentApiCredentialRoutes(app);\n',
)
replace_once("apps/identity/src/application-admin.ts", 'export const IDENTITY_CONTRACT_VERSION = "0.9.0";', 'export const IDENTITY_CONTRACT_VERSION = "0.10.0";')

# Identity OpenAPI: bump and add credential paths/security description. Keep schemas inline to avoid duplicating source of truth.
replace_once("apps/identity/openapi.yaml", "  version: 0.9.0\n", "  version: 0.10.0\n")
identity_openapi = read("apps/identity/openapi.yaml")
anchor = "  /internal/v1/agent-execution-tokens:\n"
if identity_openapi.count(anchor) != 1:
    raise SystemExit("Identity OpenAPI agent execution anchor missing")
credential_paths = r'''  /internal/v1/agents/{agentId}/api-credentials:
    parameters:
      - name: agentId
        in: path
        required: true
        schema: { type: string, pattern: ^agt_ }
    get:
      description: List opaque Agent API credential metadata for an Agent bound to the authenticated trusted Application. Plaintext and hashes are never returned.
      security: [{ applicationCredential: [] }]
      responses:
        '200': { description: Agent API credential metadata list }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { description: Agent binding not found }
    post:
      description: Create a revocable opaque lsp_agt_* Agent API credential. The credential binds Application + Agent Actor but grants no Space/model/User Authority. Plaintext is returned exactly once.
      security: [{ applicationCredential: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [label, scopes]
              properties:
                label: { type: string, minLength: 1, maxLength: 100 }
                scopes: { type: array, uniqueItems: true, items: { type: string } }
                expiresAt: { type: [string, 'null'], format: date-time }
      responses:
        '201': { description: Agent API credential created; response data includes one-time write-only token matching ^lsp_agt_ }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '403': { $ref: '#/components/responses/Forbidden' }
        '404': { description: Agent binding not found }
        '409': { description: Agent/Application binding is not active }
        '422': { $ref: '#/components/responses/ValidationError' }
  /internal/v1/agents/{agentId}/api-credentials/{credentialId}:
    parameters:
      - name: agentId
        in: path
        required: true
        schema: { type: string, pattern: ^agt_ }
      - name: credentialId
        in: path
        required: true
        schema: { type: string, pattern: ^agc_ }
    patch:
      description: Update Agent API credential metadata. scopes and expiry may only be narrowed; authority cannot be expanded in place.
      security: [{ applicationCredential: [] }]
      responses:
        '200': { description: Updated Agent API credential metadata }
        '400': { $ref: '#/components/responses/InvalidRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { description: Active Agent API credential not found }
        '422': { $ref: '#/components/responses/ValidationError' }
    delete:
      description: Immediately revoke one Agent API credential.
      security: [{ applicationCredential: [] }]
      responses:
        '204': { description: Agent API credential revoked }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { description: Active Agent API credential not found }
  /introspection/v1/agent-credentials:
    post:
      description: Internal Core-to-Identity lsp_agt_* introspection through the Cloudflare Service Binding. Returns the authenticated Application + Agent Actor and credential scope ceiling only; it never resolves User Authority.
      security: [{ internalServiceSecret: [], agentCredential: [] }]
      responses:
        '200': { description: Active Agent credential execution identity or active=false }
        '401': { description: Internal service authentication failed }
'''
write("apps/identity/openapi.yaml", identity_openapi.replace(anchor, credential_paths + anchor, 1))
# Add agentCredential bearer scheme next to serviceToken if present.
identity_openapi = read("apps/identity/openapi.yaml")
service_scheme = "    serviceToken:\n      type: http\n      scheme: bearer\n"
if service_scheme in identity_openapi and "    agentCredential:\n" not in identity_openapi:
    identity_openapi = identity_openapi.replace(service_scheme, service_scheme + "    agentCredential:\n      type: http\n      scheme: bearer\n      description: Opaque lsp_agt_* Agent API credential; accepted only on the internal introspection route.\n", 1)
write("apps/identity/openapi.yaml", identity_openapi)

# ---------------------------------------------------------------------------
# Core opaque Agent credential authentication + resolved execution principal
# ---------------------------------------------------------------------------
replace_once(
    "apps/core/src/env.ts",
    '  purpose?: "agent_execution";\n',
    '  purpose?: "agent_execution" | "agent_api";\n',
)

core_auth = read("apps/core/src/auth.ts")
core_auth = core_auth.replace(
    'const SERVICE_TOKEN_PREFIXES = ["lsp_svc_", "lsp_pat_"] as const;\n',
    'const SERVICE_TOKEN_PREFIXES = ["lsp_svc_", "lsp_pat_"] as const;\nconst AGENT_API_TOKEN_PREFIX = "lsp_agt_";\n',
    1,
)
core_auth = core_auth.replace(
    'export function isOpaqueServiceApiToken(value: string): boolean {\n  return SERVICE_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix));\n}\n',
    'export function isOpaqueServiceApiToken(value: string): boolean {\n  return SERVICE_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix));\n}\n\nexport function isOpaqueAgentApiCredential(value: string): boolean {\n  return value.startsWith(AGENT_API_TOKEN_PREFIX);\n}\n',
    1,
)
agent_introspect = r'''
export async function introspectAgentCredential(rawToken: string, env: Bindings): Promise<Principal> {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) {
    throw notConfigured("Identity Agent credential introspection binding is not configured");
  }
  let response: Response;
  try {
    response = await env.IDENTITY.fetch("https://identity.internal/introspection/v1/agent-credentials", {
      method: "POST",
      headers: {
        authorization: `Bearer ${rawToken}`,
        "x-lifespace-internal-secret": env.CORE_IDENTITY_SHARED_SECRET,
      },
    });
  } catch {
    throw unauthorized();
  }
  if (!response.ok) throw unauthorized();
  const payload = await response.json<{ data?: { active?: boolean; principal?: Principal; audience?: string } }>().catch(() => null);
  const principal = payload?.data?.principal;
  if (
    payload?.data?.active !== true
    || payload.data.audience !== "lifespace-core"
    || !principal
    || principal.type !== "agent"
    || !/^agt_[A-Za-z0-9_-]+$/u.test(principal.id)
    || typeof principal.clientId !== "string"
    || typeof principal.tokenId !== "string"
    || !Array.isArray(principal.scopes)
    || principal.scopes.some((scope) => typeof scope !== "string")
    || principal.purpose !== "agent_api"
    || principal.actor !== undefined
  ) throw unauthorized();
  return {
    type: "agent",
    id: principal.id,
    ...(typeof principal.displayName === "string" && principal.displayName.trim()
      ? { displayName: principal.displayName.trim() }
      : {}),
    clientId: principal.clientId,
    scopes: [...principal.scopes],
    tokenId: principal.tokenId,
    purpose: "agent_api",
  };
}
'''
anchor = "export function authenticate(): MiddlewareHandler<AppEnv> {\n"
if core_auth.count(anchor) != 1:
    raise SystemExit("Core auth authenticate anchor missing")
core_auth = core_auth.replace(anchor, agent_introspect + "\n" + anchor, 1)
old_branch = '''    if (isOpaqueServiceApiToken(rawToken)) {
      principal = await measurePerformancePhase(
        context,
        "security.service_token_check",
        () => introspectServiceToken(rawToken, context.env),
      );
    } else if (context.env.IDENTITY_PUBLIC_KEY) {'''
new_branch = '''    if (isOpaqueServiceApiToken(rawToken)) {
      principal = await measurePerformancePhase(
        context,
        "security.service_token_check",
        () => introspectServiceToken(rawToken, context.env),
      );
    } else if (isOpaqueAgentApiCredential(rawToken)) {
      principal = await measurePerformancePhase(
        context,
        "security.agent_credential_check",
        () => introspectAgentCredential(rawToken, context.env),
      );
    } else if (context.env.IDENTITY_PUBLIC_KEY) {'''
if old_branch not in core_auth:
    raise SystemExit("Core auth branch anchor missing")
write("apps/core/src/auth.ts", core_auth.replace(old_branch, new_branch, 1))

# Agent credential -> represented execution Principal resolver reuses existing Delegation structural validation.
delegation = read("apps/core/src/delegation-chain.ts")
insert_anchor = "export function groupDelegationChainRows(\n"
resolver = r'''
export function resolveAgentApiDelegatedPrincipal(
  authenticatedAgent: Principal,
  spaceId: string,
  leafDelegationId: string,
  rows: readonly DelegationChainRow[],
): Principal {
  if (authenticatedAgent.type !== "agent" || authenticatedAgent.actor || authenticatedAgent.purpose !== "agent_api") {
    throw new ApiError("DELEGATION_INVALID", "Agent API credential execution context is invalid", 403);
  }
  const leafToRoot = chainFromRows(rows, leafDelegationId);
  const leaf = leafToRoot[0];
  if (!leaf
    || leaf.actor_type !== "agent"
    || leaf.actor_id !== authenticatedAgent.id
    || leaf.application_id !== authenticatedAgent.clientId
    || leaf.source_space_id !== spaceId
    || (leaf.principal_type === "agent" && leaf.principal_id === authenticatedAgent.id)) {
    throw new ApiError("DELEGATION_INVALID", "Delegation does not represent this authenticated Agent credential", 403);
  }
  const resolved: Principal = {
    type: leaf.principal_type,
    id: leaf.principal_id,
    clientId: authenticatedAgent.clientId,
    scopes: [...authenticatedAgent.scopes],
    tokenId: authenticatedAgent.tokenId,
    actor: { type: "agent", id: authenticatedAgent.id },
    purpose: "agent_api",
  };
  validateStructuralDelegationChain(resolved, spaceId, leafDelegationId, rows);
  return resolved;
}

'''
if delegation.count(insert_anchor) != 1:
    raise SystemExit("delegation resolver insertion anchor missing")
write("apps/core/src/delegation-chain.ts", delegation.replace(insert_anchor, resolver + insert_anchor, 1))

model_auth = read("apps/core/src/model-authorization.ts")
model_auth = model_auth.replace(
    "  validateStructuralDelegationChain,\n",
    "  resolveAgentApiDelegatedPrincipal,\n  validateStructuralDelegationChain,\n",
    1,
)
model_auth = model_auth.replace(
    "export type ModelAccessDecision = {\n  authority: ModelAuthorityDecision;\n  policyIdentity: ModelPolicyIdentity;\n};",
    "export type ModelAccessDecision = {\n  principal: Principal;\n  authority: ModelAuthorityDecision;\n  policyIdentity: ModelPolicyIdentity;\n};",
    1,
)
model_auth = model_auth.replace(
    "  return {\n    authority: {\n",
    "  return {\n    principal,\n    authority: {\n",
    1,
)
# Replace requireModelAccessMany implementation with a wrapper + internal function, preserving existing hot path for all non-agent-api credentials.
start = model_auth.index("export async function requireModelAccessMany(\n")
end = model_auth.index("\nexport async function requireModelAccess(\n", start)
old_impl = model_auth[start:end]
new_impl = r'''async function requireModelAccessManyResolved(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
  preloadedChains: Map<string, DelegationChainRow[]> | null = null,
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
  const shouldLoadChains = preloadedChains === null && uniqueLeafIds.length > 0;
  const statements = [
    ...uniqueBases.map((entry) => entry.statement),
    ...(shouldLoadChains ? [delegationChainStatement(env, uniqueLeafIds)] : []),
  ];
  const results = await env.DB.batch<Record<string, unknown>>(statements);

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

  return prepared.map((entry) => decisionFromSnapshots(
    principal,
    spaceId,
    entry,
    baseRows.get(entry.baseKey) ?? null,
    entry.delegationId ? chainsByLeaf.get(entry.delegationId) ?? [] : [],
  ));
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
'''
model_auth = model_auth[:start] + new_impl + model_auth[end:]
write("apps/core/src/model-authorization.ts", model_auth)

# Use the resolved Principal consistently after authorization in ordinary runtime paths.
resource = read("apps/core/src/generic-resource-routes.ts")
for old, new in [
    ("requireModelPolicy(context.env, principal,", "requireModelPolicy(context.env, access.principal,"),
    ("queryTemporalResources(context.env, principal,", "queryTemporalResources(context.env, access.principal,"),
    ("queryCalendarResources(context.env, principal,", "queryCalendarResources(context.env, access.principal,"),
    ("queryCanonicalResources(\n                context.env,\n                principal,", "queryCanonicalResources(\n                context.env,\n                access.principal,"),
    ("queryCanonicalResources(\n        context.env,\n        principal,", "queryCanonicalResources(\n        context.env,\n        access.principal,"),
    ("createCapabilityAwareResource(\n        context.env,\n        principal,", "createCapabilityAwareResource(\n        context.env,\n        access.principal,"),
    ("updateCapabilityAwareResource(\n        context.env,\n        principal,", "updateCapabilityAwareResource(\n        context.env,\n        access.principal,"),
    ("deleteGenericResource(\n      context.env,\n      principal,", "deleteGenericResource(\n      context.env,\n      access.principal,"),
    ("executeCapabilityAction(\n        context.env,\n        context.get(\"principal\"),", "executeCapabilityAction(\n        context.env,\n        access.principal,"),
    ("executeWorkflowAction(\n      context.env,\n      context.get(\"principal\"),", "executeWorkflowAction(\n      context.env,\n      access.principal,"),
]:
    resource = resource.replace(old, new)
write("apps/core/src/generic-resource-routes.ts", resource)

batch = read("apps/core/src/generic-batch-routes.ts")
# After decisions, select the resolved execution principal and use it for all policy/change attribution.
anchor = "    rejectRepeatedSingleUse(decisions);\n\n    const previousById"
insert = '''    rejectRepeatedSingleUse(decisions);\n    const executionPrincipal = decisions[0]!.principal;\n    if (decisions.some((decision) =>\n      decision.principal.type !== executionPrincipal.type\n      || decision.principal.id !== executionPrincipal.id\n      || decision.principal.actor?.type !== executionPrincipal.actor?.type\n      || decision.principal.actor?.id !== executionPrincipal.actor?.id\n    )) {\n      throw new ApiError(\"DELEGATION_INVALID\", \"Batch operations must resolve to one Execution Principal\", 403);\n    }\n\n    const previousById'''
if anchor not in batch:
    raise SystemExit("generic batch decision anchor missing")
batch = batch.replace(anchor, insert, 1)
batch = batch.replace("      principal,\n      spaceId,\n      operations,\n      models,\n      decisions,", "      executionPrincipal,\n      spaceId,\n      operations,\n      models,\n      decisions,", 1)
batch = batch.replace("      principal,\n      spaceId,\n      prepared,", "      executionPrincipal,\n      spaceId,\n      prepared,", 1)
batch = batch.replace("    const executedBy = actor(principal);", "    const executedBy = actor(executionPrincipal);")
batch = batch.replace("        principal.clientId,\n        principal.type,\n        principal.id,", "        executionPrincipal.clientId,\n        executionPrincipal.type,\n        executionPrincipal.id,", 1)
write("apps/core/src/generic-batch-routes.ts", batch)

# Semantic detail and relation lookup policies need resolved Principal as well.
semantic = read("apps/core/src/runtime-model-semantic-detail.ts")
semantic = semantic.replace("requireModelPolicy(context.env, principal,", "requireModelPolicy(context.env, access.principal,")
write("apps/core/src/runtime-model-semantic-detail.ts", semantic)
relation = read("apps/core/src/relation-targets.ts")
relation = relation.replace("requireModelPolicy(context.env, principal,", "requireModelPolicy(context.env, access.principal,")
write("apps/core/src/relation-targets.ts", relation)

# Kernel version identifies the new accepted bearer/execution-context behavior.
replace_once("apps/core/src/kernel-contract.ts", '"0.43.0"', '"0.44.0"')
replace_once("apps/core/package.json", '"version": "0.43.0"', '"version": "0.44.0"')
replace_once("apps/core/openapi.yaml", '"version":"0.43.0"', '"version":"0.44.0"')
replace_once("apps/core/scripts/check-openapi.mjs", 'document.info?.version !== "0.43.0"', 'document.info?.version !== "0.44.0"')
replace_once("apps/core/AGENTS.md", "current Kernel version: 0.43.0", "current Kernel version: 0.44.0")

# Identity contract static check follows the new additive contract.
check = read("apps/identity/scripts/check-openapi.mjs")
check = check.replace('doc.info?.version !== "0.9.0"', 'doc.info?.version !== "0.10.0"')
# Agent introspection must be explicitly public-contract documented yet service-secret protected.
needle = '  "/introspection/v1/service-tokens",\n]) {'
if needle in check:
    check = check.replace(needle, '  "/introspection/v1/service-tokens",\n  "/introspection/v1/agent-credentials",\n]) {', 1)
write("apps/identity/scripts/check-openapi.mjs", check)

# ---------------------------------------------------------------------------
# Integration tests
# ---------------------------------------------------------------------------
write("apps/identity/test/agent-api-credential.integration.test.ts", r'''import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

async function request(path: string, options: RequestInit = {}) {
  return createApp().request(`http://identity.test${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    BOOTSTRAP_SECRET: "bootstrap-test",
    CORE_IDENTITY_SHARED_SECRET: "core-secret",
    ENVIRONMENT: "test",
  });
}

async function bootstrap(appId: string) {
  const response = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bootstrap-secret": "bootstrap-test" },
    body: JSON.stringify({
      id: appId,
      name: appId,
      clientType: "service",
      trustedBackend: true,
      allowedScopes: ["resources:read", "resources:write"],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string;
}

async function createAgent(secret: string) {
  const response = await request("/internal/v1/agents", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Adapter Agent" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.id as string;
}

async function introspect(token: string) {
  const response = await request("/introspection/v1/agent-credentials", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-lifespace-internal-secret": "core-secret" },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as any).data;
}

describe("Agent API credential lifecycle", () => {
  it("issues lsp_agt once, narrows scopes and revokes immediately with current Agent/Application state", async () => {
    const appId = `agent-credential-${crypto.randomUUID()}`;
    const secret = await bootstrap(appId);
    const agentId = await createAgent(secret);

    const createdResponse = await request(`/internal/v1/agents/${agentId}/api-credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "n8n", scopes: ["resources:read", "resources:write"] }),
    });
    expect(createdResponse.status).toBe(201);
    const created = ((await createdResponse.json()) as any).data;
    expect(created.id).toMatch(/^agc_/);
    expect(created.token).toMatch(/^lsp_agt_/);
    expect(created.scopes).toEqual(["resources:read", "resources:write"]);

    const list = await request(`/internal/v1/agents/${agentId}/api-credentials`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(list.status).toBe(200);
    const listed = ((await list.json()) as any).data[0];
    expect(listed.id).toBe(created.id);
    expect(listed.token).toBeUndefined();

    const active = await introspect(created.token);
    expect(active).toMatchObject({
      active: true,
      audience: "lifespace-core",
      principal: {
        type: "agent",
        id: agentId,
        clientId: appId,
        scopes: ["resources:read", "resources:write"],
        tokenId: created.id,
        purpose: "agent_api",
      },
    });
    expect(active.principal.actor).toBeUndefined();

    const reduced = await request(`/internal/v1/agents/${agentId}/api-credentials/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["resources:read"] }),
    });
    expect(reduced.status).toBe(200);
    expect((await introspect(created.token)).principal.scopes).toEqual(["resources:read"]);

    const expansion = await request(`/internal/v1/agents/${agentId}/api-credentials/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["resources:read", "resources:write"] }),
    });
    expect(expansion.status).toBe(422);

    await (env as unknown as TestEnv).DB.prepare("UPDATE agents SET status='disabled' WHERE id=?").bind(agentId).run();
    expect((await introspect(created.token)).active).toBe(false);
    await (env as unknown as TestEnv).DB.prepare("UPDATE agents SET status='active' WHERE id=?").bind(agentId).run();
    expect((await introspect(created.token)).active).toBe(true);

    const revoked = await request(`/internal/v1/agents/${agentId}/api-credentials/${created.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(revoked.status).toBe(204);
    expect((await introspect(created.token)).active).toBe(false);
  });
});
''')

write("apps/core/test/agent-api-credential.integration.test.ts", r'''import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function userToken(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "test-app",
    principal_type: "user",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function identityBinding(agentId: string, state: { active: boolean; scopes: string[] }): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      if (!request.url.endsWith("/introspection/v1/agent-credentials")) return new Response("not found", { status: 404 });
      return Response.json({
        data: state.active
          ? {
              active: true,
              audience: "lifespace-core",
              principal: {
                type: "agent",
                id: agentId,
                displayName: "Adapter Agent",
                clientId: "test-app",
                scopes: state.scopes,
                tokenId: "agc_test",
                purpose: "agent_api",
              },
            }
          : { active: false },
      });
    },
  } as Fetcher;
}

async function request(path: string, options: RequestInit, publicKey: string, identity: Fetcher) {
  return createApp().request(`http://core.test${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    IDENTITY: identity,
    CORE_IDENTITY_SHARED_SECRET: "core-secret",
    ENVIRONMENT: "test",
  });
}

async function seed(userId: string, spaceId: string) {
  const db = (env as unknown as TestEnv).DB;
  const timestamp = new Date().toISOString();
  await db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?)")
    .bind(spaceId, "Agent Credential", userId, timestamp, timestamp).run();
  await db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", timestamp, timestamp).run();
  await db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", timestamp, timestamp).run();
  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES('test-app','event','write','user',?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access='write'`).bind(userId).run();
}

function jsonData(response: Response) {
  return response.json<any>().then((payload) => payload.data);
}

describe("opaque Agent API credential execution", () => {
  it("derives represented User only from dlg_* and preserves User/Agent Change attribution", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);
    const state = { active: true, scopes: ["resources:read", "resources:write"] };
    const identity = identityBinding(agentId, state);
    const directUser = await userToken(privateKey, userId);

    const delegationResponse = await request(`/api/v1/spaces/${spaceId}/delegations`, {
      method: "POST",
      headers: { authorization: `Bearer ${directUser}`, "content-type": "application/json" },
      body: JSON.stringify({ actor: { type: "agent", id: agentId }, scope: { target: { type: "model", id: "event" }, maxAccess: "write" } }),
    }, publicKey, identity);
    expect(delegationResponse.status).toBe(201);
    const delegation = await jsonData(delegationResponse);

    const noDelegation = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: { authorization: "Bearer lsp_agt_test_credential", "content-type": "application/json" },
      body: JSON.stringify({ summary: "must not use User authority", when: { kind: "date", start: "2026-10-05", endExclusive: "2026-10-06" } }),
    }, publicKey, identity);
    expect(noDelegation.status).toBe(403);

    const createdResponse = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: {
        authorization: "Bearer lsp_agt_test_credential",
        "x-lifespace-delegation-id": delegation.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "opaque agent represented user", when: { kind: "date", start: "2026-10-05", endExclusive: "2026-10-06" } }),
    }, publicKey, identity);
    expect(createdResponse.status).toBe(201);
    const created = await jsonData(createdResponse);

    const history = await request(`/api/v1/spaces/${spaceId}/changes?recordId=${created.id}`, {
      headers: { authorization: `Bearer ${directUser}` },
    }, publicKey, identity);
    expect(history.status).toBe(200);
    const changes = await jsonData(history);
    expect(changes.items[0]).toMatchObject({
      principal: { type: "user", id: userId },
      actor: { type: "agent", id: agentId },
      applicationId: "test-app",
      delegationId: delegation.id,
    });

    state.scopes = ["resources:read"];
    const scopeDenied = await request(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      headers: {
        authorization: "Bearer lsp_agt_test_credential",
        "x-lifespace-delegation-id": delegation.id,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: "scope denied", when: { kind: "date", start: "2026-10-06", endExclusive: "2026-10-07" } }),
    }, publicKey, identity);
    expect(scopeDenied.status).toBe(403);

    state.active = false;
    const revoked = await request(`/api/v1/spaces/${spaceId}/models/event/records/${created.id}`, {
      headers: { authorization: "Bearer lsp_agt_test_credential" },
    }, publicKey, identity);
    expect(revoked.status).toBe(401);
  });
});
''')

print("Issue #307 phase A transformer applied")

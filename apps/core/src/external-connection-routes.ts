import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type ConnectionRow = {
  id: string;
  space_id: string;
  provider_key: string;
  credential_ref: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
  display_name: string | null;
  access_mode: "read" | "write";
  credential_mode: "bootstrap" | "managed";
};

type AdapterError = { code?: string; retrySafe?: boolean };
const MANAGEMENT_CONTRACT_VERSION = 1;
const MAX_BODY_BYTES = 16 * 1024;
const adapterStatus: Record<string, 400 | 404 | 409 | 422 | 429 | 502 | 503> = {
  EXTERNAL_UNAVAILABLE: 503,
  EXTERNAL_ACCESS_DENIED: 503,
  EXTERNAL_RESOURCE_UNAVAILABLE: 404,
  EXTERNAL_RATE_LIMITED: 429,
  EXTERNAL_VALIDATION_FAILED: 422,
  EXTERNAL_CONTRACT_INVALID: 502,
};

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
function now() {
  return new Date().toISOString();
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new ApiError("INVALID_REQUEST", "Unsupported request field", 400);
  }
}
function requiredString(value: unknown, name: string, max: number) {
  if (typeof value !== "string") throw new ApiError("VALIDATION_ERROR", `${name} is invalid`, 422);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new ApiError("VALIDATION_ERROR", `${name} is invalid`, 422);
  return normalized;
}
function credential(value: unknown) {
  if (!isObject(value)) throw new ApiError("VALIDATION_ERROR", "credential is invalid", 422);
  onlyKeys(value, ["type", "token"]);
  if (value.type !== "bearer_token" || typeof value.token !== "string") {
    throw new ApiError("VALIDATION_ERROR", "Only bearer_token credentials are supported by this provider", 422);
  }
  const token = value.token;
  const bytes = new TextEncoder().encode(token).length;
  if (!token || token !== token.trim() || /[\r\n]/u.test(token) || bytes > 8192) {
    throw new ApiError("VALIDATION_ERROR", "credential token is invalid", 422);
  }
  return { type: "bearer_token", token } as const;
}
function access(value: unknown) {
  if (value !== "read" && value !== "write") throw new ApiError("VALIDATION_ERROR", "access must be read or write", 422);
  return value;
}
async function requestBody(c: Context<AppEnv>) {
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) throw new ApiError("REQUEST_TOO_LARGE", "Request body is too large", 413);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new ApiError("INVALID_REQUEST", "JSON object is required", 400); }
  if (!isObject(parsed)) throw new ApiError("INVALID_REQUEST", "JSON object is required", 400);
  return parsed;
}
async function manager(c: Context<AppEnv>) {
  const principal = c.get("principal");
  if (principal.type !== "user" || principal.actor) throw new ApiError("FORBIDDEN", "Direct User management is required", 403);
  await requireSpacePermission(c.env, principal, c.req.param("spaceId")!, "manage");
}
function dto(row: ConnectionRow) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name ?? row.provider_key,
    access: row.access_mode,
    status: row.status,
    credentialMode: row.credential_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
async function connection(env: Bindings, spaceId: string, connectionId: string) {
  return env.DB.prepare("SELECT * FROM external_sources WHERE id=? AND space_id=?")
    .bind(connectionId, spaceId)
    .first<ConnectionRow>();
}

async function callAdapter(
  env: Bindings,
  body: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  if (!env.EXTERNAL_ADAPTER || !env.EXTERNAL_ADAPTER_SHARED_SECRET || env.EXTERNAL_ADAPTER_SHARED_SECRET.length < 32) {
    throw new ApiError("EXTERNAL_UNAVAILABLE", "External Adapter is not configured", 503);
  }
  let response: Response;
  try {
    response = await env.EXTERNAL_ADAPTER.fetch("https://external-adapter.internal/internal/v1/external-connections", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lifespace-internal-secret": env.EXTERNAL_ADAPTER_SHARED_SECRET,
      },
      body: JSON.stringify({ contractVersion: MANAGEMENT_CONTRACT_VERSION, ...body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError("EXTERNAL_UNAVAILABLE", "External connection service is unavailable", 503);
  }
  const text = await response.text();
  if (text.length > 1_000_000) throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External Adapter response is invalid", 502);
  let parsed: unknown;
  try { parsed = JSON.parse(text || "null"); }
  catch { throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External Adapter response is invalid", 502); }
  if (!isObject(parsed) || parsed.contractVersion !== MANAGEMENT_CONTRACT_VERSION) {
    throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External Adapter response is invalid", 502);
  }
  const error = isObject(parsed.error) ? parsed.error as AdapterError : null;
  if (!response.ok || error) {
    const code = typeof error?.code === "string" && adapterStatus[error.code] ? error.code : "EXTERNAL_UNAVAILABLE";
    throw new ApiError(code, "External connection operation could not be completed", adapterStatus[code] ?? 503);
  }
  return parsed.data;
}

async function bestEffortDeleteCredential(env: Bindings, providerKey: string, credentialRef: string) {
  try { await callAdapter(env, { providerKey, credentialRef, operation: "delete" }); }
  catch { /* orphan cleanup is best effort; generated refs are not exposed */ }
}

export function registerExternalConnectionRoutes(app: App) {
  const base = "/api/v1/spaces/:spaceId/external-connections";
  const providers = "/api/v1/spaces/:spaceId/external-providers";
  app.use(base, requireScope("spaces:manage"));
  app.use(base + "/*", requireScope("spaces:manage"));
  app.use(providers, requireScope("spaces:manage"));

  app.get(providers, async (c) => {
    await manager(c);
    const descriptor = await callAdapter(c.env, { operation: "describe" });
    if (!isObject(descriptor) || typeof descriptor.key !== "string" || typeof descriptor.displayName !== "string") {
      throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External provider descriptor is invalid", 502);
    }
    return c.json(success({ items: [descriptor] }));
  });

  app.get(base, async (c) => {
    await manager(c);
    const rows = await c.env.DB.prepare("SELECT * FROM external_sources WHERE space_id=? ORDER BY created_at,id")
      .bind(c.req.param("spaceId")!)
      .all<ConnectionRow>();
    return c.json(success({ items: rows.results.map(dto) }));
  });

  app.post(base, async (c) => {
    await manager(c);
    const input = await requestBody(c);
    onlyKeys(input, ["providerKey", "displayName", "credential", "access"]);
    const providerKey = requiredString(input.providerKey, "providerKey", 32);
    if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(providerKey)) throw new ApiError("VALIDATION_ERROR", "providerKey is invalid", 422);
    const displayName = requiredString(input.displayName, "displayName", 100);
    const providerCredential = credential(input.credential);
    const accessMode = access(input.access ?? "read");
    const credentialRef = id("cnx");
    const connectionId = id("exc");

    try {
      const projected = await callAdapter(c.env, {
        providerKey,
        credentialRef,
        operation: "create",
        credential: providerCredential,
        access: accessMode,
      });
      if (!isObject(projected) || projected.read !== true || typeof projected.write !== "boolean") {
        throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External connection projection is invalid", 502);
      }
    } catch (error) {
      await bestEffortDeleteCredential(c.env, providerKey, credentialRef);
      throw error;
    }

    const timestamp = now();
    try {
      await c.env.DB.prepare(
        "INSERT INTO external_sources(id,space_id,provider_key,credential_ref,status,created_at,updated_at,display_name,access_mode,credential_mode) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        connectionId,
        c.req.param("spaceId")!,
        providerKey,
        credentialRef,
        "active",
        timestamp,
        timestamp,
        displayName,
        accessMode,
        "managed",
      ).run();
    } catch (error) {
      await bestEffortDeleteCredential(c.env, providerKey, credentialRef);
      throw error;
    }
    const created = await connection(c.env, c.req.param("spaceId")!, connectionId);
    if (!created) throw new ApiError("EXTERNAL_UNAVAILABLE", "External connection was not persisted", 503);
    return c.json(success(dto(created)), 201);
  });

  app.get(base + "/:connectionId/resources", async (c) => {
    await manager(c);
    const row = await connection(c.env, c.req.param("spaceId")!, c.req.param("connectionId")!);
    if (!row || row.status !== "active") throw new ApiError("NOT_FOUND", "Connection not found", 404);
    if (row.credential_mode !== "managed") throw new ApiError("EXTERNAL_CONNECTION_DEPLOYMENT_MANAGED", "This connection is deployment-managed and does not expose product resource discovery", 409);
    const allowed = new Set(["query", "cursor", "limit"]);
    for (const key of c.req.query() ? Object.keys(c.req.query()) : []) if (!allowed.has(key)) throw new ApiError("VALIDATION_ERROR", `Unsupported query parameter: ${key}`, 422);
    const query = c.req.query("query") ?? "";
    const cursor = c.req.query("cursor") ?? undefined;
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (query.length > 200 || (cursor !== undefined && cursor.length > 2048) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError("VALIDATION_ERROR", "Resource query is invalid", 422);
    }
    const data = await callAdapter(c.env, {
      providerKey: row.provider_key,
      credentialRef: row.credential_ref,
      operation: "listResources",
      input: { limit, ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) },
    });
    if (!isObject(data) || !Array.isArray(data.items)) throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External resource list is invalid", 502);
    return c.json(success(data));
  });

  app.patch(base + "/:connectionId", async (c) => {
    await manager(c);
    const spaceId = c.req.param("spaceId")!;
    const connectionId = c.req.param("connectionId")!;
    const row = await connection(c.env, spaceId, connectionId);
    if (!row) throw new ApiError("NOT_FOUND", "Connection not found", 404);
    const input = await requestBody(c);
    onlyKeys(input, ["displayName", "status", "credential", "access"]);
    if (!Object.keys(input).length) throw new ApiError("INVALID_REQUEST", "A change is required", 400);
    const displayName = input.displayName === undefined ? row.display_name : requiredString(input.displayName, "displayName", 100);
    const status = input.status === undefined ? row.status : input.status;
    if (status !== "active" && status !== "disabled") throw new ApiError("VALIDATION_ERROR", "status must be active or disabled", 422);
    const accessMode = input.access === undefined ? row.access_mode : access(input.access);
    const providerCredential = input.credential === undefined ? undefined : credential(input.credential);
    if ((input.access !== undefined || providerCredential) && row.credential_mode !== "managed") {
      throw new ApiError("EXTERNAL_CONNECTION_DEPLOYMENT_MANAGED", "Deployment-managed connection credentials cannot be changed through the product API", 409);
    }
    if (input.access !== undefined || providerCredential) {
      const projected = await callAdapter(c.env, {
        providerKey: row.provider_key,
        credentialRef: row.credential_ref,
        operation: "update",
        ...(providerCredential ? { credential: providerCredential } : {}),
        ...(input.access !== undefined ? { access: accessMode } : {}),
      });
      if (!isObject(projected) || projected.read !== true || typeof projected.write !== "boolean") {
        throw new ApiError("EXTERNAL_CONTRACT_INVALID", "External connection projection is invalid", 502);
      }
    }
    const timestamp = now();
    await c.env.DB.prepare("UPDATE external_sources SET display_name=?,access_mode=?,status=?,updated_at=? WHERE id=? AND space_id=?")
      .bind(displayName, accessMode, status, timestamp, row.id, spaceId)
      .run();
    const updated = await connection(c.env, spaceId, row.id);
    if (!updated) throw new ApiError("NOT_FOUND", "Connection not found", 404);
    return c.json(success(dto(updated)));
  });
}

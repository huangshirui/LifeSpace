import agentGovernanceWorker from "./agent-governance";

interface Env {
  ENVIRONMENT: string;
  IDENTITY_BASE_URL: string;
  CORE_BASE_URL: string;
  IDENTITY_APPLICATION_CREDENTIAL?: string;
  IDENTITY?: Fetcher;
  CORE?: Fetcher;
  ASSETS: Fetcher;
}

type JsonRecord = Record<string, unknown>;
type UpstreamResult = { response: Response; payload: unknown };
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const INTENT_HEADER = "x-lifespace-console-intent";
const MAX_CONNECTION_BODY = 16 * 1024;
const MAX_BINDING_BODY = 4096;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}
function failure(code: string, message: string, status: number, id?: string): Response {
  return json({ error: { code, message, ...(id ? { requestId: id } : {}) } }, status);
}
async function readPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return null; }
}
async function serviceRequest(binding: Fetcher | undefined, baseUrl: string, path: string, init: RequestInit = {}): Promise<UpstreamResult> {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = binding ? await binding.fetch(new Request(url, init)) : await fetch(new Request(url, init));
  return { response, payload: await readPayload(response) };
}
function upstreamError(payload: unknown): { code: string; message: string; requestId?: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = stringValue(payload.error.code);
  const message = stringValue(payload.error.message);
  if (!code || !message) return null;
  return { code, message, ...(stringValue(payload.error.requestId) ? { requestId: String(payload.error.requestId) } : {}) };
}
function upstreamFailure(request: Request, result: UpstreamResult): Response {
  const error = upstreamError(result.payload);
  const passthrough = new Set([400, 401, 403, 404, 409, 413, 422, 429, 503]);
  return failure(error?.code ?? "EXTERNAL_CONFIGURATION_FAILED", error?.message ?? "External configuration request failed", passthrough.has(result.response.status) ? result.response.status : 502, error?.requestId ?? requestId(request));
}
function accessAssertion(request: Request): string | null {
  const value = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim() ?? "";
  return value && value.length <= 32768 && value.split(".").length === 3 ? value : null;
}
async function userToken(request: Request, env: Env): Promise<string | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));
  const applicationCredential = env.IDENTITY_APPLICATION_CREDENTIAL?.trim();
  if (!applicationCredential) return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request));
  const exchange = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${applicationCredential}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read", "spaces:manage"] }),
  });
  if (exchange.response.status !== 200) return upstreamFailure(request, exchange);
  if (!isRecord(exchange.payload) || !isRecord(exchange.payload.data)) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid access exchange response", 502, requestId(request));
  const token = stringValue(exchange.payload.data.accessToken);
  return token ?? failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid access exchange response", 502, requestId(request));
}
function sameOriginMutation(request: Request, intent: string): Response | null {
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin
    || request.headers.get("sec-fetch-site") !== "same-origin"
    || request.headers.get(INTENT_HEADER) !== intent
    || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return failure("INVALID_BROWSER_MUTATION", "External configuration requires an exact same-origin request and explicit intent", 403, requestId(request));
  }
  return null;
}
async function readObject(request: Request, maxBytes: number): Promise<JsonRecord | Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > maxBytes) return failure("REQUEST_TOO_LARGE", "External configuration request is too large", 413, requestId(request));
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : failure("VALIDATION_ERROR", "JSON object is required", 422, requestId(request));
  } catch {
    return failure("VALIDATION_ERROR", "JSON object is required", 422, requestId(request));
  }
}
function onlyKeys(value: JsonRecord, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function validConnectionId(value: string): boolean {
  return /^(?:exc|exs)_[a-f0-9]{32}$/u.test(value);
}
function validCredential(value: unknown): boolean {
  if (!isRecord(value) || !onlyKeys(value, ["type", "token"]) || value.type !== "bearer_token" || typeof value.token !== "string") return false;
  return Boolean(value.token) && value.token === value.token.trim() && !/[\r\n]/u.test(value.token) && new TextEncoder().encode(value.token).length <= 8192;
}
function validateCreateConnection(body: JsonRecord): boolean {
  return onlyKeys(body, ["providerKey", "displayName", "credential", "access"])
    && typeof body.providerKey === "string" && /^[a-z][a-z0-9_-]{1,31}$/u.test(body.providerKey)
    && typeof body.displayName === "string" && Boolean(body.displayName.trim()) && body.displayName.trim().length <= 100
    && validCredential(body.credential)
    && (body.access === "read" || body.access === "write");
}
function validateUpdateConnection(body: JsonRecord): boolean {
  if (!Object.keys(body).length || !onlyKeys(body, ["displayName", "status", "credential", "access"])) return false;
  if (body.displayName !== undefined && (typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.trim().length > 100)) return false;
  if (body.status !== undefined && body.status !== "active" && body.status !== "disabled") return false;
  if (body.access !== undefined && body.access !== "read" && body.access !== "write") return false;
  if (body.credential !== undefined && !validCredential(body.credential)) return false;
  return true;
}
function validateBinding(body: JsonRecord): boolean {
  return onlyKeys(body, ["definitionKey", "connectionId", "resourceId", "declaredAccess"])
    && typeof body.definitionKey === "string" && /^[a-z][a-z0-9_]{1,62}$/u.test(body.definitionKey)
    && typeof body.connectionId === "string" && validConnectionId(body.connectionId)
    && typeof body.resourceId === "string" && Boolean(body.resourceId.trim()) && body.resourceId.length <= 256
    && (body.declaredAccess === "read" || body.declaredAccess === "write");
}

function target(pathname: string): { spaceId: string; corePath: string; kind: "providers" | "connections" | "connection" | "resources" | "models" } | null {
  const providers = /^\/api\/spaces\/(spc_[A-Za-z0-9_-]+)\/external-providers$/u.exec(pathname);
  if (providers) return { spaceId: providers[1]!, corePath: `/api/v1/spaces/${encodeURIComponent(providers[1]!)}/external-providers`, kind: "providers" };
  const connections = /^\/api\/spaces\/(spc_[A-Za-z0-9_-]+)\/external-connections$/u.exec(pathname);
  if (connections) return { spaceId: connections[1]!, corePath: `/api/v1/spaces/${encodeURIComponent(connections[1]!)}/external-connections`, kind: "connections" };
  const resources = /^\/api\/spaces\/(spc_[A-Za-z0-9_-]+)\/external-connections\/((?:exc|exs)_[a-f0-9]{32})\/resources$/u.exec(pathname);
  if (resources) return { spaceId: resources[1]!, corePath: `/api/v1/spaces/${encodeURIComponent(resources[1]!)}/external-connections/${encodeURIComponent(resources[2]!)}/resources`, kind: "resources" };
  const connection = /^\/api\/spaces\/(spc_[A-Za-z0-9_-]+)\/external-connections\/((?:exc|exs)_[a-f0-9]{32})$/u.exec(pathname);
  if (connection) return { spaceId: connection[1]!, corePath: `/api/v1/spaces/${encodeURIComponent(connection[1]!)}/external-connections/${encodeURIComponent(connection[2]!)}`, kind: "connection" };
  const models = /^\/api\/spaces\/(spc_[A-Za-z0-9_-]+)\/external-models$/u.exec(pathname);
  if (models) return { spaceId: models[1]!, corePath: `/api/v1/spaces/${encodeURIComponent(models[1]!)}/external-models`, kind: "models" };
  return null;
}

async function externalConfigurationRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const route = target(url.pathname);
  if (!route) return null;
  const allowed = route.kind === "connections" ? ["GET", "POST"]
    : route.kind === "connection" ? ["PATCH"]
      : route.kind === "models" ? ["GET", "POST"]
        : ["GET"];
  if (!allowed.includes(request.method)) return failure("METHOD_NOT_ALLOWED", "Method not allowed", 405, requestId(request));

  let body: JsonRecord | undefined;
  if (request.method === "POST" || request.method === "PATCH") {
    const intent = route.kind === "connections" ? "create-external-connection"
      : route.kind === "connection" ? "update-external-connection"
        : "bind-external-model";
    const guard = sameOriginMutation(request, intent);
    if (guard) return guard;
    const parsed = await readObject(request, route.kind === "models" ? MAX_BINDING_BODY : MAX_CONNECTION_BODY);
    if (parsed instanceof Response) return parsed;
    const valid = route.kind === "connections" ? validateCreateConnection(parsed)
      : route.kind === "connection" ? validateUpdateConnection(parsed)
        : validateBinding(parsed);
    if (!valid) return failure("VALIDATION_ERROR", "Invalid External configuration request", 422, requestId(request));
    body = parsed;
  }

  let suffix = "";
  if (route.kind === "resources") {
    for (const key of url.searchParams.keys()) {
      if (!["query", "cursor", "limit"].includes(key) || url.searchParams.getAll(key).length !== 1) return failure("VALIDATION_ERROR", "Invalid resource discovery query", 422, requestId(request));
    }
    const query = url.searchParams.get("query") ?? "";
    const cursor = url.searchParams.get("cursor") ?? "";
    const rawLimit = url.searchParams.get("limit");
    if (query.length > 200 || cursor.length > 2048 || (rawLimit !== null && (!/^\d{1,3}$/u.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100))) {
      return failure("VALIDATION_ERROR", "Invalid resource discovery query", 422, requestId(request));
    }
    suffix = url.search;
  } else if (url.search) {
    return failure("VALIDATION_ERROR", "Query parameters are not accepted", 422, requestId(request));
  }

  const token = await userToken(request, env);
  if (token instanceof Response) return token;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `${route.corePath}${suffix}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!result.response.ok) return upstreamFailure(request, result);
  return json(result.payload, result.response.status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const configured = await externalConfigurationRoute(request, env);
      if (configured) return configured;
      return agentGovernanceWorker.fetch(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "LifeSpace Console External configuration failed",
        requestId: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return failure("INTERNAL_ERROR", "LifeSpace Console External configuration failed", 500, requestId(request));
    }
  },
} satisfies ExportedHandler<Env>;

import downstreamWorker from "./external-connections";

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
const MAX_BODY_BYTES = 8 * 1024;

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
function failure(code: string, message: string, status: number, id: string = crypto.randomUUID()): Response {
  return json({ error: { code, message, requestId: id } }, status);
}
async function readPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}
async function serviceRequest(binding: Fetcher | undefined, baseUrl: string, path: string, init: RequestInit = {}): Promise<UpstreamResult> {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = binding ? await binding.fetch(new Request(url.toString(), init)) : await fetch(url.toString(), init);
  return { response, payload: await readPayload(response) };
}
function upstreamError(payload: unknown): { code: string; message: string; requestId?: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = stringValue(payload.error.code), message = stringValue(payload.error.message);
  if (!code || !message) return null;
  const upstreamRequestId = stringValue(payload.error.requestId) ?? undefined;
  return { code, message, ...(upstreamRequestId ? { requestId: upstreamRequestId } : {}) };
}
function upstreamFailure(request: Request, result: UpstreamResult): Response {
  const error = upstreamError(result.payload);
  const allowed = new Set([400, 401, 403, 404, 409, 413, 422, 429, 502, 503]);
  return failure(
    error?.code ?? "EXTERNAL_CONFIGURATION_FAILED",
    error?.message ?? "External configuration request failed",
    allowed.has(result.response.status) ? result.response.status : 502,
    error?.requestId ?? requestId(request),
  );
}
function accessAssertion(request: Request): string | null {
  const value = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim() ?? "";
  return value && value.length <= 32768 && value.split(".").length === 3 ? value : null;
}
async function userBearer(request: Request, env: Env): Promise<string | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));
  const credential = env.IDENTITY_APPLICATION_CREDENTIAL?.trim();
  if (!credential) return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request));
  const exchange = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read", "spaces:manage"] }),
  });
  if (exchange.response.status !== 200) return upstreamFailure(request, exchange);
  const token = isRecord(exchange.payload) && isRecord(exchange.payload.data) ? stringValue(exchange.payload.data.accessToken) : null;
  return token ?? failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid user session", 502, requestId(request));
}
function browserMutation(request: Request, intent: string): Response | null {
  const url = new URL(request.url);
  if (
    request.headers.get("origin") !== url.origin ||
    request.headers.get("sec-fetch-site") !== "same-origin" ||
    request.headers.get(INTENT_HEADER) !== intent ||
    !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")
  ) return failure("INVALID_BROWSER_MUTATION", "External binding mutation requires an exact same-origin JSON request and explicit intent", 403, requestId(request));
  return null;
}
async function readJsonObject(request: Request, allowed: readonly string[]): Promise<JsonRecord | Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return failure("VALIDATION_ERROR", "External binding request is too large", 413, requestId(request));
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failure("VALIDATION_ERROR", "Invalid JSON object", 422, requestId(request)); }
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) return failure("VALIDATION_ERROR", "Invalid External binding request", 422, requestId(request));
  return value;
}
function validModelKey(value: string): boolean {
  return /^(?:[a-z][a-z0-9_]{1,62}|ext_[a-f0-9]{32})$/u.test(value);
}
async function forward(request: Request, env: Env, corePath: string, method: string, body?: JsonRecord): Promise<Response> {
  const bearer = await userBearer(request, env);
  if (bearer instanceof Response) return bearer;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, corePath, {
    method,
    headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!result.response.ok) return upstreamFailure(request, result);
  return json(result.payload, result.response.status);
}

async function bindingApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/api\/spaces\/(spc_[A-Za-z0-9_-]+)\/external-models(?:\/([a-z][a-z0-9_]{1,62}|ext_[a-f0-9]{32}))?(?:\/(refresh))?$/u.exec(url.pathname);
  if (!match) return null;
  const [, spaceId, modelKey, child] = match;
  if (!spaceId || url.search) return failure("VALIDATION_ERROR", "External binding path is invalid", 422, requestId(request));

  if (!modelKey) {
    if (request.method === "GET") return forward(request, env, `/api/v1/spaces/${encodeURIComponent(spaceId)}/external-models`, "GET");
    return null; // POST binding remains owned by the downstream External Connection BFF.
  }
  if (!validModelKey(modelKey)) return failure("VALIDATION_ERROR", "modelKey is invalid", 422, requestId(request));

  if (child === "refresh") {
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED", "Method not allowed", 405, requestId(request));
    const guard = browserMutation(request, "refresh-external-model-binding"); if (guard) return guard;
    const input = await readJsonObject(request, []); if (input instanceof Response) return input;
    return forward(request, env, `/api/v1/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(modelKey)}/refresh`, "POST", input);
  }
  if (child) return failure("NOT_FOUND", "Console API route not found", 404, requestId(request));
  if (request.method === "PATCH") {
    const guard = browserMutation(request, "update-external-model-binding"); if (guard) return guard;
    const input = await readJsonObject(request, ["status", "declaredAccess"]); if (input instanceof Response) return input;
    if (!Object.keys(input).length) return failure("VALIDATION_ERROR", "A binding change is required", 422, requestId(request));
    return forward(request, env, `/api/v1/spaces/${encodeURIComponent(spaceId)}/external-models/${encodeURIComponent(modelKey)}`, "PATCH", input);
  }
  return failure("METHOD_NOT_ALLOWED", "Method not allowed", 405, requestId(request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const handled = await bindingApi(request, env);
    if (handled) return handled;
    return downstreamWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

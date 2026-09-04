import configurationCenterWorker from "./configuration-center";

interface Env {
  ENVIRONMENT: string;
  IDENTITY_BASE_URL: string;
  CORE_BASE_URL: string;
  IDENTITY_APPLICATION_CREDENTIAL?: string;
  CORE_EXECUTOR_BEARER?: string;
  IDENTITY?: Fetcher;
  CORE?: Fetcher;
  ASSETS: Fetcher;
}

type JsonRecord = Record<string, unknown>;
type UpstreamResult = { response: Response; payload: unknown };
type IdentityAdminContext = { actorToken: string; identityCredential: string };

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const INTENT_HEADER = "x-lifespace-console-intent";
const MAX_BODY_BYTES = 64 * 1024;
const intents = {
  createAgent: "create-agent-identity",
  updateAgent: "update-agent-identity",
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dataRecord(payload: unknown): JsonRecord | null {
  return isRecord(payload) && isRecord(payload.data) ? payload.data : null;
}

function dataArray(payload: unknown): unknown[] | null {
  return isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
}

function upstreamError(payload: unknown): { code: string; message: string; requestId?: string } | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = stringValue(payload.error.code);
  const message = stringValue(payload.error.message);
  if (!code || !message) return null;
  const requestId = stringValue(payload.error.requestId) ?? undefined;
  return { code, message, ...(requestId ? { requestId } : {}) };
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

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}

function failure(code: string, message: string, status: number, requestIdValue?: string): Response {
  return json({ error: { code, message, ...(requestIdValue ? { requestId: requestIdValue } : {}) } }, status);
}

async function readPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw) as unknown; }
  catch { return null; }
}

async function serviceRequest(binding: Fetcher | undefined, baseUrl: string, path: string, init: RequestInit = {}): Promise<UpstreamResult> {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const upstreamRequest = new Request(url.toString(), init);
  const response = binding ? await binding.fetch(upstreamRequest) : await fetch(upstreamRequest);
  return { response, payload: await readPayload(response) };
}

function upstreamFailure(request: Request, result: UpstreamResult, fallbackCode: string, fallbackMessage: string): Response {
  const error = upstreamError(result.payload);
  const passthrough = new Set([400, 401, 403, 404, 409, 413, 422, 429, 503]);
  const status = passthrough.has(result.response.status) ? result.response.status : 502;
  return failure(error?.code ?? fallbackCode, error?.message ?? fallbackMessage, status, error?.requestId ?? requestId(request));
}

function accessAssertion(request: Request): string | null {
  const value = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim() ?? "";
  return value && value.length <= 32768 && value.split(".").length === 3 ? value : null;
}

function requiredIdentityCredential(env: Env): string | null {
  const value = env.IDENTITY_APPLICATION_CREDENTIAL?.trim() ?? "";
  return value || null;
}

async function requireIdentityAdminContext(request: Request, env: Env): Promise<IdentityAdminContext | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));
  const identityCredential = requiredIdentityCredential(env);
  if (!identityCredential) return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request));

  const exchange = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${identityCredential}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read"] }),
  });
  if (exchange.response.status !== 200) return upstreamFailure(request, exchange, "ACCESS_EXCHANGE_FAILED", "LifeSpace Identity rejected the Access assertion");
  const userToken = stringValue(dataRecord(exchange.payload)?.accessToken);
  if (!userToken) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid access exchange response", 502, requestId(request));

  const proof = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (proof.response.status !== 200) return upstreamFailure(request, proof, "PLATFORM_ADMIN_PROOF_DENIED", "Current LifeSpace user is not authorized for platform administration");
  const actorToken = stringValue(dataRecord(proof.payload)?.actorToken);
  if (!actorToken) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid platform-admin proof", 502, requestId(request));
  return { actorToken, identityCredential };
}

function identityHeaders(context: IdentityAdminContext, jsonBody = false): HeadersInit {
  return {
    authorization: `Bearer ${context.identityCredential}`,
    "x-lifespace-actor-token": context.actorToken,
    accept: "application/json",
    ...(jsonBody ? { "content-type": "application/json" } : {}),
  };
}

function exactSameOriginMutation(request: Request, intent: string): Response | null {
  const url = new URL(request.url);
  const origin = request.headers.get("origin")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim() ?? "";
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  const suppliedIntent = request.headers.get(INTENT_HEADER)?.trim() ?? "";
  if (origin !== url.origin || fetchSite !== "same-origin" || suppliedIntent !== intent || !contentType.startsWith("application/json")) {
    return failure("INVALID_BROWSER_MUTATION", "Mutation requires an exact same-origin Console request with explicit intent", 403, requestId(request));
  }
  return null;
}

async function readJsonObject(request: Request): Promise<JsonRecord | Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return failure("REQUEST_TOO_LARGE", `Console mutation body must not exceed ${MAX_BODY_BYTES} bytes`, 413, requestId(request));
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : failure("INVALID_REQUEST", "Request body must be a JSON object", 400, requestId(request));
  } catch {
    return failure("INVALID_REQUEST", "Request body must be valid JSON", 400, requestId(request));
  }
}

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

function sanitizeAgent(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const applicationId = stringValue(value.applicationId);
  const name = stringValue(value.displayName);
  const status = stringValue(value.status);
  if (!id || !applicationId || !name || (status !== "active" && status !== "disabled") || !isRecord(value.binding)) return null;
  const bindingStatus = stringValue(value.binding.status);
  if (bindingStatus !== "active" && bindingStatus !== "revoked") return null;
  return {
    id,
    applicationId,
    displayName: name,
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    binding: {
      status: bindingStatus,
      createdAt: value.binding.createdAt,
      revokedAt: value.binding.revokedAt ?? null,
    },
  };
}

function collectionTarget(pathname: string): string | null {
  const match = /^\/api\/agent-governance\/applications\/([^/]+)\/agents$/u.exec(pathname);
  if (!match) return null;
  try {
    const applicationId = decodeURIComponent(match[1]);
    return validApplicationId(applicationId) ? applicationId : null;
  } catch { return null; }
}

function itemTarget(pathname: string): { applicationId: string; agentId: string } | null {
  const match = /^\/api\/agent-governance\/applications\/([^/]+)\/agents\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    const applicationId = decodeURIComponent(match[1]);
    const agentId = decodeURIComponent(match[2]);
    return validApplicationId(applicationId) && validAgentId(agentId) ? { applicationId, agentId } : null;
  } catch { return null; }
}

async function listAgents(request: Request, env: Env, applicationId: string): Promise<Response> {
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents`, {
    headers: identityHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "AGENT_LIST_FAILED", "Agent identity lookup failed");
  const rows = dataArray(result.payload);
  if (!rows) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid Agent list", 502, requestId(request));
  const agents = rows.map(sanitizeAgent);
  return agents.every(Boolean) ? json({ data: agents }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent metadata", 502, requestId(request));
}

async function createAgent(request: Request, env: Env, applicationId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createAgent);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["displayName", "confirmApplicationId"].includes(key)) || body.confirmApplicationId !== applicationId) {
    return failure("CONFIRMATION_REQUIRED", "Agent creation requires confirmApplicationId to exactly match the target Application", 422, requestId(request));
  }
  const name = displayName(body.displayName);
  if (!name) return failure("VALIDATION_ERROR", "displayName must contain 1-100 characters", 422, requestId(request));

  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents`, {
    method: "POST",
    headers: identityHeaders(context, true),
    body: JSON.stringify({ displayName: name }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "AGENT_CREATE_FAILED", "Agent identity creation failed");
  const agent = sanitizeAgent(dataRecord(result.payload));
  return agent ? json({ data: agent }, 201) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent metadata", 502, requestId(request));
}

async function updateAgent(request: Request, env: Env, applicationId: string, agentId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateAgent);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["displayName", "status", "confirmApplicationId", "confirmAgentId", "confirmGlobalStatus"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId) {
    return failure("CONFIRMATION_REQUIRED", "Agent update requires exact Application and Agent confirmation", 422, requestId(request));
  }
  const patch: JsonRecord = {};
  if (body.displayName !== undefined) {
    const name = displayName(body.displayName);
    if (!name) return failure("VALIDATION_ERROR", "displayName must contain 1-100 characters", 422, requestId(request));
    patch.displayName = name;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return failure("VALIDATION_ERROR", "status must be active or disabled", 422, requestId(request));
    if (body.confirmGlobalStatus !== true) return failure("GLOBAL_STATUS_CONFIRMATION_REQUIRED", "Changing Agent status is global and requires explicit confirmation", 422, requestId(request));
    patch.status = body.status;
  }
  if (!Object.keys(patch).length) return failure("INVALID_REQUEST", "At least one mutable Agent field is required", 400, requestId(request));

  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    headers: identityHeaders(context, true),
    body: JSON.stringify(patch),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "AGENT_UPDATE_FAILED", "Agent identity update failed");
  const agent = sanitizeAgent(dataRecord(result.payload));
  return agent ? json({ data: agent }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent metadata", 502, requestId(request));
}

async function agentGovernanceRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const collection = collectionTarget(url.pathname);
  if (collection) {
    if (request.method === "GET") return listAgents(request, env, collection);
    if (request.method === "POST") return createAgent(request, env, collection);
  }
  const item = itemTarget(url.pathname);
  if (item && request.method === "PATCH") return updateAgent(request, env, item.applicationId, item.agentId);
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await agentGovernanceRoute(request, env);
      if (response) return response;
      return configurationCenterWorker.fetch(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "LifeSpace Console Agent governance failed",
        requestId: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return failure("INTERNAL_ERROR", "LifeSpace Console Agent governance failed", 500, requestId(request));
    }
  },
} satisfies ExportedHandler<Env>;

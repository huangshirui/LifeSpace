import controlPlaneWorker from "./control-plane";

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
const MAX_SCOPES = 64;

const intents = {
  createApplication: "create-platform-application",
  updateApplication: "update-platform-application",
  registerAccessAudience: "register-access-audience",
  revokeAccessAudience: "revoke-access-audience",
} as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dataRecord(payload: unknown): JsonRecord | null {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  return payload.data;
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

async function serviceRequest(
  binding: Fetcher | undefined,
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<UpstreamResult> {
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
  if (!value || value.length > 32768 || value.split(".").length !== 3) return null;
  return value;
}

function validApplicationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value);
}

function validAudienceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value);
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
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch { return failure("INVALID_REQUEST", "Request body must be valid JSON", 400, requestId(request)); }
  if (!isRecord(parsed)) return failure("INVALID_REQUEST", "Request body must be a JSON object", 400, requestId(request));
  return parsed;
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
    headers: {
      authorization: `Bearer ${identityCredential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
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

function normalizeScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) return null;
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const scope = item.trim();
    if (!scope || scope.length > 100 || /\s/u.test(scope)) return null;
    if (!seen.has(scope)) {
      seen.add(scope);
      scopes.push(scope);
    }
  }
  return scopes;
}

function sanitizeApplication(data: JsonRecord): JsonRecord {
  const allowed = ["id", "name", "allowedScopes", "trustedBackend", "accessTokenTtlSeconds", "status", "createdAt", "updatedAt"];
  return Object.fromEntries(allowed.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

function sanitizeAudience(data: JsonRecord): JsonRecord {
  const allowed = ["id", "applicationId", "issuer", "audience", "status", "createdAt", "revokedAt"];
  return Object.fromEntries(allowed.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

async function createApplication(request: Request, env: Env): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createApplication);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowedKeys = new Set(["name", "allowedScopes", "trustedBackend", "accessTokenTtlSeconds", "confirmName"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) return failure("INVALID_REQUEST", "Application creation contains unsupported fields", 400, requestId(request));

  const name = stringValue(body.name)?.trim() ?? "";
  const scopes = normalizeScopes(body.allowedScopes ?? []);
  const trustedBackend = body.trustedBackend ?? false;
  const ttl = body.accessTokenTtlSeconds ?? 900;
  if (!name || name.length > 100 || body.confirmName !== name) return failure("CONFIRMATION_REQUIRED", "Application creation requires confirmName to exactly match name", 422, requestId(request));
  if (!scopes) return failure("VALIDATION_ERROR", "allowedScopes must contain at most 64 non-empty scope strings", 422, requestId(request));
  if (typeof trustedBackend !== "boolean") return failure("VALIDATION_ERROR", "trustedBackend must be boolean", 422, requestId(request));
  if (!Number.isInteger(ttl) || Number(ttl) < 300 || Number(ttl) > 3600) return failure("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", 422, requestId(request));

  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/applications", {
    method: "POST",
    headers: identityHeaders(context, true),
    body: JSON.stringify({ name, allowedScopes: scopes, trustedBackend, accessTokenTtlSeconds: Number(ttl) }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "APPLICATION_CREATE_FAILED", "Application creation failed");
  const created = dataRecord(result.payload);
  if (!created || !validApplicationId(stringValue(created.id) ?? "")) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid application response", 502, requestId(request));

  // Current Console security policy does not allow lsa_* plaintext in browser JavaScript.
  // Identity creates one credential together with a trusted-backend application, so revoke that
  // generated credential immediately and return only the authoritative application metadata.
  let initialCredentialRevoked = false;
  if (trustedBackend) {
    const credential = isRecord(created.credential) ? created.credential : null;
    const credentialId = credential ? stringValue(credential.id) : null;
    if (!credentialId) return failure("UPSTREAM_RESPONSE_INVALID", "Trusted-backend creation did not return revocable credential metadata", 502, requestId(request));
    const revoke = await serviceRequest(
      env.IDENTITY,
      env.IDENTITY_BASE_URL,
      `/internal/v1/platform-admin/applications/${encodeURIComponent(String(created.id))}/credentials/${encodeURIComponent(credentialId)}`,
      { method: "DELETE", headers: identityHeaders(context) },
    );
    if (revoke.response.status !== 204) return upstreamFailure(request, revoke, "INITIAL_CREDENTIAL_REVOKE_FAILED", "Application was created but its one-time bootstrap credential could not be revoked safely");
    initialCredentialRevoked = true;
  }

  return json({ data: { application: sanitizeApplication(created), initialCredentialRevoked } }, 201);
}

async function updateApplication(request: Request, env: Env, applicationId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateApplication);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowedKeys = new Set(["name", "allowedScopes", "accessTokenTtlSeconds", "status", "confirmApplicationId"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key)) || body.confirmApplicationId !== applicationId) {
    return failure("CONFIRMATION_REQUIRED", "Application update requires confirmApplicationId to exactly match the target application", 422, requestId(request));
  }
  const patch: JsonRecord = {};
  if (body.name !== undefined) {
    const name = stringValue(body.name)?.trim() ?? "";
    if (!name || name.length > 100) return failure("VALIDATION_ERROR", "name must contain 1-100 characters", 422, requestId(request));
    patch.name = name;
  }
  if (body.allowedScopes !== undefined) {
    const scopes = normalizeScopes(body.allowedScopes);
    if (!scopes) return failure("VALIDATION_ERROR", "allowedScopes must contain at most 64 non-empty scope strings", 422, requestId(request));
    patch.allowedScopes = scopes;
  }
  if (body.accessTokenTtlSeconds !== undefined) {
    if (!Number.isInteger(body.accessTokenTtlSeconds) || Number(body.accessTokenTtlSeconds) < 300 || Number(body.accessTokenTtlSeconds) > 3600) {
      return failure("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", 422, requestId(request));
    }
    patch.accessTokenTtlSeconds = body.accessTokenTtlSeconds;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return failure("VALIDATION_ERROR", "status must be active or disabled", 422, requestId(request));
    patch.status = body.status;
  }
  if (!Object.keys(patch).length) return failure("INVALID_REQUEST", "At least one mutable application field is required", 400, requestId(request));

  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}`, {
    method: "PATCH",
    headers: identityHeaders(context, true),
    body: JSON.stringify(patch),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "APPLICATION_UPDATE_FAILED", "Application update failed");
  const updated = dataRecord(result.payload);
  return updated ? json({ data: sanitizeApplication(updated) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid application response", 502, requestId(request));
}

async function registerAccessAudience(request: Request, env: Env, applicationId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.registerAccessAudience);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "audience" && key !== "confirmApplicationId") || body.confirmApplicationId !== applicationId) {
    return failure("CONFIRMATION_REQUIRED", "Audience registration requires confirmApplicationId to exactly match the target application", 422, requestId(request));
  }
  const audience = stringValue(body.audience)?.trim() ?? "";
  if (!audience || audience.length > 256 || /\s/u.test(audience)) return failure("VALIDATION_ERROR", "audience must contain 1-256 non-whitespace characters", 422, requestId(request));

  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/access-audiences`, {
    method: "POST",
    headers: identityHeaders(context, true),
    body: JSON.stringify({ audience }),
  });
  if (result.response.status !== 200 && result.response.status !== 201) return upstreamFailure(request, result, "ACCESS_AUDIENCE_REGISTER_FAILED", "Access audience registration failed");
  const registered = dataRecord(result.payload);
  return registered ? json({ data: sanitizeAudience(registered) }, result.response.status) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid Access audience response", 502, requestId(request));
}

async function revokeAccessAudience(request: Request, env: Env, applicationId: string, audienceId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.revokeAccessAudience);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "confirmApplicationId" && key !== "confirmAudienceId")
    || body.confirmApplicationId !== applicationId
    || body.confirmAudienceId !== audienceId
  ) {
    return failure("CONFIRMATION_REQUIRED", "Audience revocation requires exact application and audience confirmation", 422, requestId(request));
  }

  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(
    env.IDENTITY,
    env.IDENTITY_BASE_URL,
    `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/access-audiences/${encodeURIComponent(audienceId)}`,
    { method: "DELETE", headers: identityHeaders(context) },
  );
  if (result.response.status !== 204) return upstreamFailure(request, result, "ACCESS_AUDIENCE_REVOKE_FAILED", "Access audience revocation failed");
  return json({ data: { applicationId, audienceId, revoked: true } });
}

function applicationTarget(pathname: string): string | null {
  const match = /^\/api\/application-config\/applications\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return validApplicationId(value) ? value : null;
  } catch { return null; }
}

function audienceCollectionTarget(pathname: string): string | null {
  const match = /^\/api\/application-config\/applications\/([^/]+)\/access-audiences$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return validApplicationId(value) ? value : null;
  } catch { return null; }
}

function audienceItemTarget(pathname: string): { applicationId: string; audienceId: string } | null {
  const match = /^\/api\/application-config\/applications\/([^/]+)\/access-audiences\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    const applicationId = decodeURIComponent(match[1]);
    const audienceId = decodeURIComponent(match[2]);
    return validApplicationId(applicationId) && validAudienceId(audienceId) ? { applicationId, audienceId } : null;
  } catch { return null; }
}

async function applicationConfigurationRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/application-config/applications") return createApplication(request, env);
  const applicationId = applicationTarget(url.pathname);
  if (request.method === "PATCH" && applicationId) return updateApplication(request, env, applicationId);
  const audienceApplicationId = audienceCollectionTarget(url.pathname);
  if (request.method === "POST" && audienceApplicationId) return registerAccessAudience(request, env, audienceApplicationId);
  const audienceTarget = audienceItemTarget(url.pathname);
  if (request.method === "DELETE" && audienceTarget) return revokeAccessAudience(request, env, audienceTarget.applicationId, audienceTarget.audienceId);
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const mutation = await applicationConfigurationRoute(request, env);
      if (mutation) return mutation;
      return controlPlaneWorker.fetch(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "LifeSpace Console application configuration failed",
        requestId: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return failure("INTERNAL_ERROR", "LifeSpace Console application configuration failed", 500, requestId(request));
    }
  },
} satisfies ExportedHandler<Env>;

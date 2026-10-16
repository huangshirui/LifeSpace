import readOnlyWorker from "./index";

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
type AdminContext = {
  actorToken: string;
  identityCredential: string;
  coreExecutor: string;
};

type GrantPermission = "free_busy" | "read" | "write" | "manage";
type GrantResourceType = "space" | "model";
type GrantGranteeType = "user" | "space" | "service" | "device" | "agent";

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const INTENT_HEADER = "x-lifespace-console-intent";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_MODEL_ACCESS_ENTRIES = 200;

const intents = {
  replaceModelAccess: "replace-application-model-access",
  validateModel: "validate-model-definition",
  publishModel: "publish-model-definition",
  retireModel: "retire-model",
  createGrant: "create-space-data-grant",
  updateGrant: "update-space-data-grant",
  revokeGrant: "revoke-space-data-grant",
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

function dataArray(payload: unknown): unknown[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return null;
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

function requiredSecret(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is not configured`);
  return value.trim();
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

function validModelKey(value: string): boolean {
  return /^[a-z][a-z0-9_]{1,62}$/u.test(value);
}

function validSpaceId(value: string): boolean {
  return /^spc_[A-Za-z0-9_-]+$/u.test(value);
}

function validGrantId(value: string): boolean {
  return /^grt_[A-Za-z0-9_-]+$/u.test(value);
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

async function requireAdminContext(request: Request, env: Env): Promise<AdminContext | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));

  let identityCredential: string;
  let coreExecutor: string;
  try {
    identityCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL");
    coreExecutor = requiredSecret(env.CORE_EXECUTOR_BEARER, "CORE_EXECUTOR_BEARER");
  } catch {
    return failure("CONSOLE_NOT_CONFIGURED", "Console platform executors are not configured", 503, requestId(request));
  }

  const exchange = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${identityCredential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read"] }),
  });
  if (exchange.response.status !== 200) {
    return upstreamFailure(request, exchange, "ACCESS_EXCHANGE_FAILED", "LifeSpace Identity rejected the Access assertion");
  }
  const userToken = stringValue(dataRecord(exchange.payload)?.accessToken);
  if (!userToken) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid access exchange response", 502, requestId(request));

  const proof = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (proof.response.status !== 200) {
    return upstreamFailure(request, proof, "PLATFORM_ADMIN_PROOF_DENIED", "Current LifeSpace user is not authorized for platform administration");
  }
  const actorToken = stringValue(dataRecord(proof.payload)?.actorToken);
  if (!actorToken) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid platform-admin proof", 502, requestId(request));

  return { actorToken, identityCredential, coreExecutor };
}

function coreHeaders(context: AdminContext, jsonBody = false): HeadersInit {
  return {
    authorization: `Bearer ${context.coreExecutor}`,
    "x-lifespace-actor-token": context.actorToken,
    accept: "application/json",
    ...(jsonBody ? { "content-type": "application/json" } : {}),
  };
}

async function platformModels(request: Request, env: Env): Promise<Response> {
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/models", { headers: coreHeaders(context) });
  if (result.response.status !== 200) return upstreamFailure(request, result, "MODEL_LIST_FAILED", "Published model lookup failed");
  const data = dataArray(result.payload);
  return data ? json({ data }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid model list", 502, requestId(request));
}

async function platformModel(request: Request, env: Env, modelKey: string): Promise<Response> {
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/models/${encodeURIComponent(modelKey)}`, { headers: coreHeaders(context) });
  if (result.response.status !== 200) return upstreamFailure(request, result, "MODEL_LOOKUP_FAILED", "Published model lookup failed");
  const data = dataRecord(result.payload);
  return data ? json({ data }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid model response", 502, requestId(request));
}

function normalizeModelAccessBody(
  body: JsonRecord,
  request: Request,
  applicationId: string,
): { models: Array<{ modelKey: string; maxAccess: "read" | "write" | "manage" }> } | Response {
  if (Object.keys(body).some((key) => key !== "models" && key !== "confirmApplicationId") || !Array.isArray(body.models)) {
    return failure("INVALID_REQUEST", "Request must contain only models and confirmApplicationId", 400, requestId(request));
  }
  if (body.confirmApplicationId !== applicationId) {
    return failure("CONFIRMATION_REQUIRED", "Model Access replacement requires confirmApplicationId to exactly match the target application", 422, requestId(request));
  }
  if (body.models.length > MAX_MODEL_ACCESS_ENTRIES) {
    return failure("VALIDATION_ERROR", `At most ${MAX_MODEL_ACCESS_ENTRIES} model access entries are allowed`, 422, requestId(request));
  }
  const seen = new Set<string>();
  const models: Array<{ modelKey: string; maxAccess: "read" | "write" | "manage" }> = [];
  for (const entry of body.models) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "modelKey" && key !== "maxAccess")) {
      return failure("VALIDATION_ERROR", "Each model access entry must contain only modelKey and maxAccess", 422, requestId(request));
    }
    const modelKey = stringValue(entry.modelKey);
    const maxAccess = entry.maxAccess;
    if (!modelKey || !validModelKey(modelKey) || (maxAccess !== "read" && maxAccess !== "write" && maxAccess !== "manage")) {
      return failure("VALIDATION_ERROR", "Each model access entry requires a valid modelKey and read/write/manage maxAccess", 422, requestId(request));
    }
    if (seen.has(modelKey)) return failure("VALIDATION_ERROR", `Duplicate model access entry: ${modelKey}`, 422, requestId(request));
    seen.add(modelKey);
    models.push({ modelKey, maxAccess });
  }
  return { models };
}

async function replaceApplicationModelAccess(request: Request, env: Env, applicationId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.replaceModelAccess);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const normalized = normalizeModelAccessBody(body, request, applicationId);
  if (normalized instanceof Response) return normalized;
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/model-access`, {
    method: "PUT",
    headers: coreHeaders(context, true),
    body: JSON.stringify(normalized),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "MODEL_ACCESS_UPDATE_FAILED", "Application model access update failed");
  const data = dataRecord(result.payload);
  return data ? json({ data }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid model-access response", 502, requestId(request));
}

async function validateModelDefinition(request: Request, env: Env): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.validateModel);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "definition") || body.definition === undefined) {
    return failure("INVALID_REQUEST", "Request must contain only definition", 400, requestId(request));
  }
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/models/validate", {
    method: "POST",
    headers: coreHeaders(context, true),
    body: JSON.stringify({ definition: body.definition }),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "MODEL_VALIDATION_FAILED", "Model Definition validation failed");
  const data = dataRecord(result.payload);
  return data ? json({ data }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid validation response", 502, requestId(request));
}

async function publishModelDefinition(request: Request, env: Env): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.publishModel);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (
    Object.keys(body).some((key) => key !== "definition" && key !== "compatibility" && key !== "confirmModelKey" && key !== "breakingConfirmation")
    || body.definition === undefined
  ) {
    return failure("INVALID_REQUEST", "Request must contain definition, compatibility and publish confirmation", 400, requestId(request));
  }
  const compatibility = body.compatibility;
  if (compatibility !== "initial" && compatibility !== "compatible" && compatibility !== "breaking") {
    return failure("VALIDATION_ERROR", "compatibility must be initial, compatible, or breaking", 422, requestId(request));
  }
  const definitionModelKey = isRecord(body.definition) ? stringValue(body.definition.key) : null;
  if (!definitionModelKey || !validModelKey(definitionModelKey) || body.confirmModelKey !== definitionModelKey) {
    return failure("CONFIRMATION_REQUIRED", "Publication requires confirmModelKey to exactly match definition.key", 422, requestId(request));
  }
  if (compatibility === "breaking" && body.breakingConfirmation !== "BREAKING") {
    return failure("CONFIRMATION_REQUIRED", "Breaking publication requires breakingConfirmation=BREAKING", 422, requestId(request));
  }
  if (compatibility !== "breaking" && body.breakingConfirmation !== undefined) {
    return failure("INVALID_REQUEST", "breakingConfirmation is allowed only for breaking publication", 400, requestId(request));
  }
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/models", {
    method: "POST",
    headers: coreHeaders(context, true),
    body: JSON.stringify({ definition: body.definition, compatibility }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "MODEL_PUBLISH_FAILED", "Model publication failed");
  const data = dataRecord(result.payload);
  return data ? json({ data }, 201) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid publication response", 502, requestId(request));
}

async function retireModel(request: Request, env: Env, modelKey: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.retireModel);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "confirmModelKey") || body.confirmModelKey !== modelKey) {
    return failure("CONFIRMATION_REQUIRED", "Retirement requires confirmModelKey to exactly match the target model", 422, requestId(request));
  }
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/models/${encodeURIComponent(modelKey)}/retire`, {
    method: "POST",
    headers: coreHeaders(context, true),
    body: "{}",
  });
  if (result.response.status !== 204) return upstreamFailure(request, result, "MODEL_RETIRE_FAILED", "Model retirement failed");
  return json({ data: { modelKey, retired: true } });
}

function grantPermission(value: unknown): value is GrantPermission {
  return value === "free_busy" || value === "read" || value === "write" || value === "manage";
}

function granteeType(value: unknown): value is GrantGranteeType {
  return value === "user" || value === "space" || value === "service" || value === "device" || value === "agent";
}

function resourceType(value: unknown): value is GrantResourceType {
  return value === "space" || value === "model";
}

async function createDataGrant(request: Request, env: Env, spaceId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createGrant);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["granteeType", "granteeId", "resourceType", "resourceId", "permission", "expiresAt", "confirmSpaceId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return failure("INVALID_REQUEST", "Grant creation contains unsupported fields", 400, requestId(request));
  if (body.confirmSpaceId !== spaceId) return failure("CONFIRMATION_REQUIRED", "Grant creation requires confirmSpaceId to exactly match the target Space", 422, requestId(request));
  const targetGranteeType = body.granteeType;
  const targetGranteeId = stringValue(body.granteeId)?.trim() ?? "";
  const targetResourceType = body.resourceType === undefined ? "space" : body.resourceType;
  const targetPermission = body.permission;
  if (!granteeType(targetGranteeType) || !targetGranteeId || !resourceType(targetResourceType) || !grantPermission(targetPermission)) {
    return failure("VALIDATION_ERROR", "Grant requires valid granteeType, granteeId, resourceType and permission", 422, requestId(request));
  }
  if (targetResourceType === "space" && body.resourceId !== undefined && body.resourceId !== null) {
    return failure("VALIDATION_ERROR", "Space grants must omit resourceId", 422, requestId(request));
  }
  const resourceId = targetResourceType === "model" ? stringValue(body.resourceId)?.trim() ?? "" : null;
  if (targetResourceType === "model" && (!resourceId || !validModelKey(resourceId))) {
    return failure("VALIDATION_ERROR", "Model grants require a valid model resourceId", 422, requestId(request));
  }
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces/${encodeURIComponent(spaceId)}/grants`, {
    method: "POST",
    headers: coreHeaders(context, true),
    body: JSON.stringify({
      granteeType: targetGranteeType,
      granteeId: targetGranteeId,
      resourceType: targetResourceType,
      resourceId,
      permission: targetPermission,
      expiresAt: body.expiresAt ?? null,
    }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "GRANT_CREATE_FAILED", "Data Grant creation failed");
  const data = dataRecord(result.payload);
  return data ? json({ data }, 201) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid Data Grant response", 502, requestId(request));
}

async function updateDataGrant(request: Request, env: Env, spaceId: string, grantId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateGrant);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["permission", "expiresAt", "confirmGrantId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return failure("INVALID_REQUEST", "Grant update contains unsupported fields", 400, requestId(request));
  if (body.confirmGrantId !== grantId) return failure("CONFIRMATION_REQUIRED", "Grant update requires confirmGrantId to exactly match the target Grant", 422, requestId(request));
  if (body.permission === undefined && body.expiresAt === undefined) return failure("INVALID_REQUEST", "Grant update requires permission and/or expiresAt", 400, requestId(request));
  if (body.permission !== undefined && !grantPermission(body.permission)) return failure("VALIDATION_ERROR", "permission is invalid", 422, requestId(request));
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(grantId)}`, {
    method: "PATCH",
    headers: coreHeaders(context, true),
    body: JSON.stringify({
      ...(body.permission === undefined ? {} : { permission: body.permission }),
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
    }),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "GRANT_UPDATE_FAILED", "Data Grant update failed");
  const data = dataRecord(result.payload);
  return data ? json({ data }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Core returned an invalid Data Grant response", 502, requestId(request));
}

async function revokeDataGrant(request: Request, env: Env, spaceId: string, grantId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.revokeGrant);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "confirmGrantId") || body.confirmGrantId !== grantId) {
    return failure("CONFIRMATION_REQUIRED", "Grant revocation requires confirmGrantId to exactly match the target Grant", 422, requestId(request));
  }
  const context = await requireAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces/${encodeURIComponent(spaceId)}/grants/${encodeURIComponent(grantId)}`, {
    method: "DELETE",
    headers: coreHeaders(context),
  });
  if (result.response.status !== 204) return upstreamFailure(request, result, "GRANT_REVOKE_FAILED", "Data Grant revocation failed");
  return json({ data: { grantId, revoked: true } });
}

function applicationModelAccessTarget(pathname: string): string | null {
  const match = /^\/api\/applications\/([^/]+)\/model-access$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return validApplicationId(value) ? value : null;
  } catch {
    return null;
  }
}

function modelTarget(pathname: string): string | null {
  const match = /^\/api\/models\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return validModelKey(value) ? value : null;
  } catch {
    return null;
  }
}

function retireTarget(pathname: string): string | null {
  const match = /^\/api\/models\/([^/]+)\/retire$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return validModelKey(value) ? value : null;
  } catch {
    return null;
  }
}

function spaceGrantCollectionTarget(pathname: string): string | null {
  const match = /^\/api\/spaces\/([^/]+)\/grants$/u.exec(pathname);
  if (!match) return null;
  try {
    const value = decodeURIComponent(match[1]);
    return validSpaceId(value) ? value : null;
  } catch {
    return null;
  }
}

function spaceGrantItemTarget(pathname: string): { spaceId: string; grantId: string } | null {
  const match = /^\/api\/spaces\/([^/]+)\/grants\/([^/]+)$/u.exec(pathname);
  if (!match) return null;
  try {
    const targetSpaceId = decodeURIComponent(match[1]);
    const targetGrantId = decodeURIComponent(match[2]);
    return validSpaceId(targetSpaceId) && validGrantId(targetGrantId) ? { spaceId: targetSpaceId, grantId: targetGrantId } : null;
  } catch {
    return null;
  }
}

async function controlPlaneRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/models") return platformModels(request, env);
  const readModelKey = modelTarget(url.pathname);
  if (request.method === "GET" && readModelKey) return platformModel(request, env, readModelKey);

  const applicationId = applicationModelAccessTarget(url.pathname);
  if (request.method === "PUT" && applicationId) return replaceApplicationModelAccess(request, env, applicationId);
  if (request.method === "POST" && url.pathname === "/api/models/validate") return validateModelDefinition(request, env);
  if (request.method === "POST" && url.pathname === "/api/models/publish") return publishModelDefinition(request, env);
  const retireModelKey = retireTarget(url.pathname);
  if (request.method === "POST" && retireModelKey) return retireModel(request, env, retireModelKey);

  const grantCollectionSpaceId = spaceGrantCollectionTarget(url.pathname);
  if (request.method === "POST" && grantCollectionSpaceId) return createDataGrant(request, env, grantCollectionSpaceId);
  const grantTarget = spaceGrantItemTarget(url.pathname);
  if (request.method === "PATCH" && grantTarget) return updateDataGrant(request, env, grantTarget.spaceId, grantTarget.grantId);
  if (request.method === "DELETE" && grantTarget) return revokeDataGrant(request, env, grantTarget.spaceId, grantTarget.grantId);
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const route = await controlPlaneRoute(request, env);
      if (route) return route;
      return readOnlyWorker.fetch(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "LifeSpace Console control-plane operation failed",
        requestId: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return failure("INTERNAL_ERROR", "LifeSpace Console control-plane operation failed", 500, requestId(request));
    }
  },
} satisfies ExportedHandler<Env>;

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
type ConsoleUser = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
};
type LinkedSession = {
  status: "linked";
  userToken: string;
  user: ConsoleUser;
};
type UnlinkedSession = { status: "unlinked" };
type AdminContext = {
  session: LinkedSession;
  actorToken: string;
  identityCredential: string;
  coreExecutor?: string;
};

const IDENTITY_PLATFORM_ADMIN_CONTRACT = "0.3.0";
const CORE_PLATFORM_ADMIN_CONTRACT = "0.2.0";
const CONSOLE_VERSION = "0.1.0";
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const REGISTRATION_INTENT_HEADER = "x-lifespace-console-intent";
const REGISTRATION_INTENT = "register-current-access-principal";
const MAX_INSPECTOR_RESULTS = 200;

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

function failure(code: string, message: string, status: number, requestId?: string): Response {
  return json({ error: { code, message, ...(requestId ? { requestId } : {}) } }, status);
}

function environment(env: Env): "local" | "staging" | "production" {
  return env.ENVIRONMENT === "production" ? "production" : env.ENVIRONMENT === "staging" ? "staging" : "local";
}

function requiredSecret(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is not configured`);
  return value.trim();
}

function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
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

function upstreamFailure(
  request: Request,
  result: UpstreamResult,
  fallbackCode: string,
  fallbackMessage: string,
): Response {
  const error = upstreamError(result.payload);
  const passthrough = new Set([400, 401, 403, 404, 409, 422, 429, 503]);
  const status = passthrough.has(result.response.status) ? result.response.status : 502;
  return failure(
    error?.code ?? fallbackCode,
    error?.message ?? fallbackMessage,
    status,
    error?.requestId ?? requestId(request),
  );
}

function invalidUpstream(request: Request, service: string): Response {
  return failure("UPSTREAM_RESPONSE_INVALID", `${service} returned an invalid control-plane response`, 502, requestId(request));
}

function accessAssertion(request: Request): string | null {
  const value = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim() ?? "";
  if (!value || value.length > 32768 || value.split(".").length !== 3) return null;
  return value;
}

function requireSameOriginRegistration(request: Request): Response | null {
  const url = new URL(request.url);
  const origin = request.headers.get("origin")?.trim() ?? "";
  const fetchSite = request.headers.get("sec-fetch-site")?.trim() ?? "";
  const intent = request.headers.get(REGISTRATION_INTENT_HEADER)?.trim() ?? "";
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";

  if (origin !== url.origin || fetchSite !== "same-origin" || intent !== REGISTRATION_INTENT || !contentType.startsWith("application/json")) {
    return failure("INVALID_BROWSER_MUTATION", "Registration requires an exact same-origin Console request", 403, requestId(request));
  }
  return null;
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const displayName = value.trim();
  return displayName && displayName.length <= 50 ? displayName : null;
}

function sessionData(env: Env, user: ConsoleUser) {
  return {
    environment: environment(env),
    consoleVersion: CONSOLE_VERSION,
    identityAdminApiVersion: IDENTITY_PLATFORM_ADMIN_CONTRACT,
    coreAdminApiVersion: CORE_PLATFORM_ADMIN_CONTRACT,
    user,
  };
}

async function profileFromUserToken(request: Request, env: Env, userToken: string): Promise<ConsoleUser | Response> {
  const profile = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me", {
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (profile.response.status !== 200) {
    return upstreamFailure(request, profile, "PROFILE_LOOKUP_FAILED", "LifeSpace profile lookup failed");
  }
  const profileData = dataRecord(profile.payload);
  const id = stringValue(profileData?.id);
  const displayName = stringValue(profileData?.displayName);
  const status = stringValue(profileData?.status);
  if (!id || !displayName || !status) return invalidUpstream(request, "LifeSpace Identity");
  return {
    id,
    displayName,
    avatarUrl: typeof profileData?.avatarUrl === "string" ? profileData.avatarUrl : null,
    status,
  };
}

async function exchangeAccess(request: Request, env: Env): Promise<LinkedSession | UnlinkedSession | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));

  let applicationCredential: string;
  try { applicationCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL"); }
  catch { return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request)); }

  const exchange = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${applicationCredential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read"] }),
  });

  const exchangeError = upstreamError(exchange.payload);
  if (exchange.response.status === 409 && exchangeError?.code === "ACCESS_PRINCIPAL_UNLINKED") return { status: "unlinked" };
  if (exchange.response.status !== 200) {
    return upstreamFailure(request, exchange, "ACCESS_EXCHANGE_FAILED", "LifeSpace Identity rejected the Access assertion");
  }

  const userToken = stringValue(dataRecord(exchange.payload)?.accessToken);
  if (!userToken) return invalidUpstream(request, "LifeSpace Identity");
  const user = await profileFromUserToken(request, env, userToken);
  if (user instanceof Response) return user;
  return { status: "linked", userToken, user };
}

async function registerAccessUser(request: Request, env: Env): Promise<Response> {
  if (environment(env) !== "staging") {
    return failure("REGISTRATION_NOT_AVAILABLE", "Console first-use registration is available only in staging proving", 404, requestId(request));
  }
  const browserGuard = requireSameOriginRegistration(request);
  if (browserGuard) return browserGuard;

  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));

  const body = await request.json().catch(() => null) as unknown;
  const displayName = isRecord(body) ? normalizeDisplayName(body.displayName) : null;
  if (!displayName) return failure("VALIDATION_ERROR", "displayName must contain 1-50 characters", 422, requestId(request));

  let applicationCredential: string;
  try { applicationCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL"); }
  catch { return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request)); }

  const registration = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/registrations", {
    method: "POST",
    headers: {
      authorization: `Bearer ${applicationCredential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read"], displayName }),
  });

  if (registration.response.status !== 201) {
    return upstreamFailure(request, registration, "ACCESS_REGISTRATION_FAILED", "LifeSpace Identity rejected the Access registration");
  }

  const userToken = stringValue(dataRecord(registration.payload)?.accessToken);
  if (!userToken) return invalidUpstream(request, "LifeSpace Identity");
  const user = await profileFromUserToken(request, env, userToken);
  if (user instanceof Response) return user;
  return json({ data: sessionData(env, user) }, 201);
}

async function issueActorProof(request: Request, env: Env, userToken: string): Promise<string | Response> {
  const issued = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (issued.response.status !== 200) {
    return upstreamFailure(request, issued, "PLATFORM_ADMIN_PROOF_DENIED", "Current LifeSpace user is not authorized for platform administration");
  }
  const token = stringValue(dataRecord(issued.payload)?.actorToken);
  if (!token) return invalidUpstream(request, "LifeSpace Identity");
  return token;
}

async function requireAdminContext(request: Request, env: Env, requireCore: boolean): Promise<AdminContext | Response> {
  const session = await exchangeAccess(request, env);
  if (session instanceof Response) return session;
  if (session.status === "unlinked") {
    return failure(
      "ACCESS_PRINCIPAL_UNLINKED",
      "Cloudflare Access principal must be explicitly linked before platform administration",
      409,
      requestId(request),
    );
  }

  const actorToken = await issueActorProof(request, env, session.userToken);
  if (actorToken instanceof Response) return actorToken;

  try {
    const identityCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL");
    const coreExecutor = requireCore ? requiredSecret(env.CORE_EXECUTOR_BEARER, "CORE_EXECUTOR_BEARER") : undefined;
    return { session, actorToken, identityCredential, ...(coreExecutor ? { coreExecutor } : {}) };
  } catch {
    return failure("CONSOLE_NOT_CONFIGURED", "Console platform executors are not configured", 503, requestId(request));
  }
}

function identityAdminHeaders(context: AdminContext): HeadersInit {
  return {
    authorization: `Bearer ${context.identityCredential}`,
    "x-lifespace-actor-token": context.actorToken,
    accept: "application/json",
  };
}

function coreAdminHeaders(context: AdminContext): HeadersInit {
  if (!context.coreExecutor) throw new Error("Core executor is not available in this admin context");
  return {
    authorization: `Bearer ${context.coreExecutor}`,
    "x-lifespace-actor-token": context.actorToken,
    accept: "application/json",
  };
}

function validApplicationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value);
}

function validModelKey(value: string): boolean {
  return /^[a-z][a-z0-9_]{1,62}$/u.test(value);
}

function validUserId(value: string): boolean {
  return /^usr_[A-Za-z0-9_-]+$/u.test(value);
}

function validSpaceId(value: string): boolean {
  return /^spc_[A-Za-z0-9_-]+$/u.test(value);
}

function decodeSingleSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try { return decodeURIComponent(encoded); }
  catch { return null; }
}

function onlyQueryKeys(url: URL, allowed: Set<string>, request: Request): Response | null {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return failure("VALIDATION_ERROR", `Unsupported query parameter: ${key}`, 422, requestId(request));
    if (url.searchParams.getAll(key).length > 1) return failure("VALIDATION_ERROR", `Query parameter ${key} may appear only once`, 422, requestId(request));
  }
  return null;
}

function boundedLimit(url: URL, request: Request, fallback = 50): number | Response {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_INSPECTOR_RESULTS) {
    return failure("VALIDATION_ERROR", `limit must be an integer between 1 and ${MAX_INSPECTOR_RESULTS}`, 422, requestId(request));
  }
  return value;
}

function userInspectorQuery(url: URL, request: Request): string | Response {
  const invalid = onlyQueryKeys(url, new Set(["q", "status", "limit"]), request);
  if (invalid) return invalid;
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length > 100) return failure("VALIDATION_ERROR", "q must contain at most 100 characters", 422, requestId(request));
  const status = url.searchParams.get("status")?.trim() ?? "";
  if (status && status !== "active" && status !== "disabled") {
    return failure("VALIDATION_ERROR", "status must be active or disabled", 422, requestId(request));
  }
  const limit = boundedLimit(url, request);
  if (limit instanceof Response) return limit;
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  return `?${params.toString()}`;
}

function spaceInspectorQuery(url: URL, request: Request): string | Response {
  const invalid = onlyQueryKeys(url, new Set(["q", "limit"]), request);
  if (invalid) return invalid;
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length > 100) return failure("VALIDATION_ERROR", "q must contain at most 100 characters", 422, requestId(request));
  const limit = boundedLimit(url, request);
  if (limit instanceof Response) return limit;
  const params = new URLSearchParams({ limit: String(limit) });
  if (q) params.set("q", q);
  return `?${params.toString()}`;
}

function auditLimit(url: URL, request: Request): number | Response {
  const invalid = onlyQueryKeys(url, new Set(["limit"]), request);
  if (invalid) return invalid;
  return boundedLimit(url, request, 100);
}

function sourcedAudit(payload: unknown, source: "identity" | "core"): JsonRecord[] | null {
  const rows = dataArray(payload);
  if (!rows) return null;
  return rows.filter(isRecord).map((row) => ({ ...row, source }));
}

async function sessionRoute(request: Request, env: Env): Promise<Response> {
  const session = await exchangeAccess(request, env);
  if (session instanceof Response) return session;
  if (session.status === "unlinked") {
    return failure(
      "ACCESS_PRINCIPAL_UNLINKED",
      "This Cloudflare Access principal is not linked to a LifeSpace user. LifeSpace will not create or merge an account by email automatically.",
      409,
      requestId(request),
    );
  }
  return json({ data: sessionData(env, session.user) });
}

async function overviewRoute(request: Request, env: Env): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;

  const [identityStatus, coreStatus, applications, users, spaces, identityAudit, coreAudit, models] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/status"),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/status"),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/applications", { headers: identityAdminHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/users?limit=${MAX_INSPECTOR_RESULTS}`, { headers: identityAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces?limit=${MAX_INSPECTOR_RESULTS}`, { headers: coreAdminHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/audit?limit=8", { headers: identityAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/audit?limit=8", { headers: coreAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/model-admin/models", { headers: coreAdminHeaders(context) }),
  ]);

  const checks: Array<[UpstreamResult, string, string]> = [
    [identityStatus, "IDENTITY_STATUS_FAILED", "Identity status lookup failed"],
    [coreStatus, "CORE_STATUS_FAILED", "Core status lookup failed"],
    [applications, "APPLICATION_INSPECTOR_FAILED", "Application inspector lookup failed"],
    [users, "USER_INSPECTOR_FAILED", "User inspector lookup failed"],
    [spaces, "SPACE_INSPECTOR_FAILED", "Space inspector lookup failed"],
    [identityAudit, "IDENTITY_AUDIT_FAILED", "Identity audit lookup failed"],
    [coreAudit, "CORE_AUDIT_FAILED", "Core audit lookup failed"],
    [models, "MODEL_INSPECTOR_FAILED", "Model Registry lookup failed"],
  ];
  for (const [result, code, message] of checks) {
    if (result.response.status !== 200) return upstreamFailure(request, result, code, message);
  }

  const identityStatusData = dataRecord(identityStatus.payload);
  const coreStatusData = dataRecord(coreStatus.payload);
  const applicationRows = dataArray(applications.payload);
  const userRows = dataArray(users.payload);
  const spaceRows = dataArray(spaces.payload);
  const modelRows = dataArray(models.payload);
  const identityAuditRows = sourcedAudit(identityAudit.payload, "identity");
  const coreAuditRows = sourcedAudit(coreAudit.payload, "core");
  if (!identityStatusData || !coreStatusData || !applicationRows || !userRows || !spaceRows || !modelRows || !identityAuditRows || !coreAuditRows) {
    return invalidUpstream(request, "LifeSpace control plane");
  }

  const recentAudit = [...identityAuditRows, ...coreAuditRows]
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))
    .slice(0, 10);

  return json({
    data: {
      generatedAt: new Date().toISOString(),
      environment: environment(env),
      counts: {
        applications: applicationRows.length,
        models: modelRows.length,
        users: userRows.length,
        usersTruncated: userRows.length === MAX_INSPECTOR_RESULTS,
        spaces: spaceRows.length,
        spacesTruncated: spaceRows.length === MAX_INSPECTOR_RESULTS,
      },
      identityStatus: identityStatusData,
      coreStatus: coreStatusData,
      recentAudit,
    },
  });
}

async function applicationsRoute(request: Request, env: Env): Promise<Response> {
  const context = await requireAdminContext(request, env, false);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/applications", {
    headers: identityAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "APPLICATION_INSPECTOR_FAILED", "Application inspector lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows }) : invalidUpstream(request, "LifeSpace Identity");
}

async function applicationDetailRoute(request: Request, env: Env, applicationId: string): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const id = encodeURIComponent(applicationId);
  const [application, credentials, audiences, servicePrincipals, modelAccess] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${id}`, { headers: identityAdminHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${id}/credentials`, { headers: identityAdminHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${id}/access-audiences`, { headers: identityAdminHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${id}/service-principals`, { headers: identityAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/applications/${id}/model-access`, { headers: coreAdminHeaders(context) }),
  ]);

  const checks: Array<[UpstreamResult, string, string]> = [
    [application, "APPLICATION_INSPECTOR_FAILED", "Application lookup failed"],
    [credentials, "APPLICATION_CREDENTIAL_INSPECTOR_FAILED", "Application credential metadata lookup failed"],
    [audiences, "ACCESS_AUDIENCE_INSPECTOR_FAILED", "Access audience lookup failed"],
    [servicePrincipals, "SERVICE_PRINCIPAL_INSPECTOR_FAILED", "Service principal lookup failed"],
    [modelAccess, "MODEL_ACCESS_INSPECTOR_FAILED", "Application model-access lookup failed"],
  ];
  for (const [result, code, message] of checks) {
    if (result.response.status !== 200) return upstreamFailure(request, result, code, message);
  }

  const applicationData = dataRecord(application.payload);
  const credentialRows = dataArray(credentials.payload);
  const audienceRows = dataArray(audiences.payload);
  const principalRows = dataArray(servicePrincipals.payload);
  const modelAccessData = dataRecord(modelAccess.payload);
  const modelRows = modelAccessData && Array.isArray(modelAccessData.models) ? modelAccessData.models : null;
  if (!applicationData || !credentialRows || !audienceRows || !principalRows || !modelRows) return invalidUpstream(request, "LifeSpace control plane");

  return json({
    data: {
      application: applicationData,
      credentials: credentialRows,
      accessAudiences: audienceRows,
      servicePrincipals: principalRows,
      modelAccess: modelRows,
    },
  });
}

async function modelsRoute(request: Request, env: Env): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/model-admin/models", {
    headers: coreAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "MODEL_INSPECTOR_FAILED", "Model Registry lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows }) : invalidUpstream(request, "LifeSpace Core");
}

async function modelDetailRoute(request: Request, env: Env, modelKey: string): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/model-admin/models/${encodeURIComponent(modelKey)}`, {
    headers: coreAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "MODEL_INSPECTOR_FAILED", "Published model lookup failed");
  const model = dataRecord(result.payload);
  return model ? json({ data: model }) : invalidUpstream(request, "LifeSpace Core");
}

async function usersRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const query = userInspectorQuery(url, request);
  if (query instanceof Response) return query;
  const context = await requireAdminContext(request, env, false);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/users${query}`, {
    headers: identityAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "USER_INSPECTOR_FAILED", "User inspector lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows }) : invalidUpstream(request, "LifeSpace Identity");
}

async function userDetailRoute(request: Request, env: Env, userId: string): Promise<Response> {
  const context = await requireAdminContext(request, env, false);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/users/${encodeURIComponent(userId)}`, {
    headers: identityAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "USER_INSPECTOR_FAILED", "User inspector lookup failed");
  const user = dataRecord(result.payload);
  return user ? json({ data: user }) : invalidUpstream(request, "LifeSpace Identity");
}

async function spacesRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const query = spaceInspectorQuery(url, request);
  if (query instanceof Response) return query;
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces${query}`, {
    headers: coreAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "SPACE_INSPECTOR_FAILED", "Space inspector lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows }) : invalidUpstream(request, "LifeSpace Core");
}

async function spaceDetailRoute(request: Request, env: Env, spaceId: string): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces/${encodeURIComponent(spaceId)}`, {
    headers: coreAdminHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "SPACE_INSPECTOR_FAILED", "Space inspector lookup failed");
  const space = dataRecord(result.payload);
  return space ? json({ data: space }) : invalidUpstream(request, "LifeSpace Core");
}

async function auditRoute(request: Request, env: Env, url: URL): Promise<Response> {
  const limit = auditLimit(url, request);
  if (limit instanceof Response) return limit;
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const [identity, core] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/audit?limit=${limit}`, { headers: identityAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/audit?limit=${limit}`, { headers: coreAdminHeaders(context) }),
  ]);
  if (identity.response.status !== 200) return upstreamFailure(request, identity, "IDENTITY_AUDIT_FAILED", "Identity audit lookup failed");
  if (core.response.status !== 200) return upstreamFailure(request, core, "CORE_AUDIT_FAILED", "Core audit lookup failed");
  const identityRows = sourcedAudit(identity.payload, "identity");
  const coreRows = sourcedAudit(core.payload, "core");
  if (!identityRows || !coreRows) return invalidUpstream(request, "LifeSpace control plane");
  return json({ data: { identity: identityRows, core: coreRows } });
}

async function systemRoute(request: Request, env: Env): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const [identityStatus, coreStatus, identityExecutorProbe, coreExecutorProbe] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/status"),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/status"),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/audit?limit=1", { headers: identityAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/audit?limit=1", { headers: coreAdminHeaders(context) }),
  ]);
  if (identityStatus.response.status !== 200) return upstreamFailure(request, identityStatus, "IDENTITY_STATUS_FAILED", "Identity status lookup failed");
  if (coreStatus.response.status !== 200) return upstreamFailure(request, coreStatus, "CORE_STATUS_FAILED", "Core status lookup failed");
  if (identityExecutorProbe.response.status !== 200) return upstreamFailure(request, identityExecutorProbe, "IDENTITY_EXECUTOR_PROBE_FAILED", "Identity Console executor check failed");
  if (coreExecutorProbe.response.status !== 200) return upstreamFailure(request, coreExecutorProbe, "CORE_EXECUTOR_PROBE_FAILED", "Core Console executor check failed");
  const identityStatusData = dataRecord(identityStatus.payload);
  const coreStatusData = dataRecord(coreStatus.payload);
  if (!identityStatusData || !coreStatusData) return invalidUpstream(request, "LifeSpace status services");
  return json({
    data: {
      environment: environment(env),
      consoleVersion: CONSOLE_VERSION,
      identityAdminApiVersion: IDENTITY_PLATFORM_ADMIN_CONTRACT,
      coreAdminApiVersion: CORE_PLATFORM_ADMIN_CONTRACT,
      identityStatus: identityStatusData,
      coreStatus: coreStatusData,
      securityBoundary: {
        accessAssertion: "server-only",
        lifespaceUserBearer: "server-only",
        actorProof: "server-only",
        identityExecutor: "server-only",
        coreExecutor: "server-only",
        bootstrapAuthority: "not-runtime",
      },
    },
  });
}

async function platformProbeRoute(request: Request, env: Env): Promise<Response> {
  const context = await requireAdminContext(request, env, true);
  if (context instanceof Response) return context;
  const [identityStatus, coreStatus, applications, identityAudit, spaces, coreAudit, models] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/status"),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/status"),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/applications", { headers: identityAdminHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/audit?limit=1", { headers: identityAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/spaces?limit=1", { headers: coreAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/audit?limit=1", { headers: coreAdminHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/model-admin/models", { headers: coreAdminHeaders(context) }),
  ]);
  const checks = {
    identityStatus: identityStatus.response.status === 200,
    coreStatus: coreStatus.response.status === 200,
    identityPlatformAdmin: applications.response.status === 200,
    identityAudit: identityAudit.response.status === 200,
    coreSpaceInspector: spaces.response.status === 200,
    coreAudit: coreAudit.response.status === 200,
    serviceModelAdmin: models.response.status === 200,
  };
  if (Object.values(checks).some((value) => !value)) {
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    return failure("CONTROL_PLANE_PROBE_FAILED", `One or more control-plane checks failed: ${failed.join(", ")}`, 502, requestId(request));
  }
  const identityStatusData = dataRecord(identityStatus.payload);
  const coreStatusData = dataRecord(coreStatus.payload);
  const applicationRows = dataArray(applications.payload);
  const modelRows = dataArray(models.payload);
  if (!identityStatusData || !coreStatusData || !applicationRows || !modelRows) return invalidUpstream(request, "LifeSpace control plane");
  return json({
    data: {
      ok: true,
      environment: environment(env),
      user: context.session.user,
      consoleVersion: CONSOLE_VERSION,
      contracts: {
        identity: stringValue(identityStatusData.contractVersion),
        identityPlatformAdmin: IDENTITY_PLATFORM_ADMIN_CONTRACT,
        coreKernel: stringValue(coreStatusData.contractVersion),
        corePlatformAdmin: CORE_PLATFORM_ADMIN_CONTRACT,
      },
      schemas: {
        identity: identityStatusData.schemaVersion ?? null,
        core: coreStatusData.schemaVersion ?? null,
      },
      counts: {
        applications: applicationRows.length,
        publishedModels: modelRows.length,
      },
      checks,
      secretsExposedToBrowser: false,
      actorProofExposedToBrowser: false,
      mutationsPerformed: false,
    },
  });
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({
      data: {
        status: "ok",
        service: "lifespace-console",
        environment: environment(env),
        version: CONSOLE_VERSION,
        frontend: "react-vite",
        provingShell: false,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/api/session") return sessionRoute(request, env);
  if (request.method === "POST" && url.pathname === "/api/session/register") return registerAccessUser(request, env);
  if (request.method === "GET" && url.pathname === "/api/platform/probe") return platformProbeRoute(request, env);
  if (request.method === "GET" && url.pathname === "/api/overview") return overviewRoute(request, env);
  if (request.method === "GET" && url.pathname === "/api/applications") return applicationsRoute(request, env);
  if (request.method === "GET" && url.pathname.startsWith("/api/applications/")) {
    const applicationId = decodeSingleSegment(url.pathname, "/api/applications/");
    if (!applicationId || !validApplicationId(applicationId)) return failure("VALIDATION_ERROR", "applicationId is invalid", 422, requestId(request));
    return applicationDetailRoute(request, env, applicationId);
  }
  if (request.method === "GET" && url.pathname === "/api/models") return modelsRoute(request, env);
  if (request.method === "GET" && url.pathname.startsWith("/api/models/")) {
    const modelKey = decodeSingleSegment(url.pathname, "/api/models/");
    if (!modelKey || !validModelKey(modelKey)) return failure("VALIDATION_ERROR", "modelKey is invalid", 422, requestId(request));
    return modelDetailRoute(request, env, modelKey);
  }
  if (request.method === "GET" && url.pathname === "/api/users") return usersRoute(request, env, url);
  if (request.method === "GET" && url.pathname.startsWith("/api/users/")) {
    const userId = decodeSingleSegment(url.pathname, "/api/users/");
    if (!userId || !validUserId(userId)) return failure("VALIDATION_ERROR", "userId is invalid", 422, requestId(request));
    return userDetailRoute(request, env, userId);
  }
  if (request.method === "GET" && url.pathname === "/api/spaces") return spacesRoute(request, env, url);
  if (request.method === "GET" && url.pathname.startsWith("/api/spaces/")) {
    const spaceId = decodeSingleSegment(url.pathname, "/api/spaces/");
    if (!spaceId || !validSpaceId(spaceId)) return failure("VALIDATION_ERROR", "spaceId is invalid", 422, requestId(request));
    return spaceDetailRoute(request, env, spaceId);
  }
  if (request.method === "GET" && url.pathname === "/api/audit") return auditRoute(request, env, url);
  if (request.method === "GET" && url.pathname === "/api/system") return systemRoute(request, env);
  return failure("NOT_FOUND", "Console API route not found", 404, requestId(request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try { return await api(request, env); }
      catch (error) {
        console.error(JSON.stringify({
          message: "LifeSpace Console request failed",
          requestId: requestId(request),
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }));
        return failure("INTERNAL_ERROR", "LifeSpace Console request failed", 500, requestId(request));
      }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

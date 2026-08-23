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

type LinkedSession = {
  status: "linked";
  userToken: string;
  user: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    status: string;
  };
};

type UnlinkedSession = {
  status: "unlinked";
};

const IDENTITY_PLATFORM_ADMIN_CONTRACT = "0.1.0";
const CORE_PLATFORM_ADMIN_CONTRACT = "0.1.0";
const CONSOLE_VERSION = "0.0.2";
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const REGISTRATION_INTENT_HEADER = "x-lifespace-console-intent";
const REGISTRATION_INTENT = "register-staging-user";

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

async function profileFromUserToken(request: Request, env: Env, userToken: string): Promise<LinkedSession["user"] | Response> {
  const profile = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me", {
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (profile.response.status !== 200) {
    const error = upstreamError(profile.payload);
    return failure(error?.code ?? "PROFILE_LOOKUP_FAILED", error?.message ?? "LifeSpace profile lookup failed", 502, error?.requestId ?? requestId(request));
  }
  const profileData = dataRecord(profile.payload);
  const id = stringValue(profileData?.id);
  const displayName = stringValue(profileData?.displayName);
  const status = stringValue(profileData?.status);
  if (!id || !displayName || !status) return failure("IDENTITY_RESPONSE_INVALID", "LifeSpace Identity returned an invalid profile", 502, requestId(request));
  return {
    id,
    displayName,
    avatarUrl: typeof profileData?.avatarUrl === "string" ? profileData.avatarUrl : null,
    status,
  };
}

async function exchangeAccess(request: Request, env: Env): Promise<LinkedSession | UnlinkedSession | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) {
    return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));
  }

  let applicationCredential: string;
  try { applicationCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL"); }
  catch {
    return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request));
  }

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
  if (exchange.response.status === 409 && exchangeError?.code === "ACCESS_PRINCIPAL_UNLINKED") {
    return { status: "unlinked" };
  }
  if (exchange.response.status !== 200) {
    const status = exchange.response.status === 503 ? 503 : exchange.response.status === 401 ? 401 : 403;
    return failure(
      exchangeError?.code ?? "ACCESS_EXCHANGE_FAILED",
      exchangeError?.message ?? "LifeSpace Identity rejected the Access assertion",
      status,
      exchangeError?.requestId ?? requestId(request),
    );
  }

  const exchangeData = dataRecord(exchange.payload);
  const userToken = stringValue(exchangeData?.accessToken);
  if (!userToken) return failure("IDENTITY_RESPONSE_INVALID", "LifeSpace Identity returned an invalid user credential response", 502, requestId(request));

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

  const body = await request.json<unknown>().catch(() => null);
  const displayName = isRecord(body) ? normalizeDisplayName(body.displayName) : null;
  if (!displayName) return failure("VALIDATION_ERROR", "displayName must contain 1-50 characters", 422, requestId(request));

  let applicationCredential: string;
  try { applicationCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL"); }
  catch {
    return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request));
  }

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
    const error = upstreamError(registration.payload);
    const status = registration.response.status === 409 ? 409 : registration.response.status === 422 ? 422 : registration.response.status === 503 ? 503 : 403;
    return failure(
      error?.code ?? "ACCESS_REGISTRATION_FAILED",
      error?.message ?? "LifeSpace Identity rejected the Access registration",
      status,
      error?.requestId ?? requestId(request),
    );
  }

  const registrationData = dataRecord(registration.payload);
  const userToken = stringValue(registrationData?.accessToken);
  if (!userToken) return failure("IDENTITY_RESPONSE_INVALID", "LifeSpace Identity returned an invalid registration response", 502, requestId(request));

  const user = await profileFromUserToken(request, env, userToken);
  if (user instanceof Response) return user;

  return json({
    data: {
      status: "linked",
      environment: environment(env),
      user,
      consoleVersion: CONSOLE_VERSION,
      created: true,
    },
  }, 201);
}

async function issueActorProof(request: Request, env: Env, userToken: string): Promise<string | Response> {
  const issued = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (issued.response.status !== 200) {
    const error = upstreamError(issued.payload);
    const status = issued.response.status === 401 ? 401 : issued.response.status === 503 ? 503 : 403;
    return failure(
      error?.code ?? "PLATFORM_ADMIN_PROOF_DENIED",
      error?.message ?? "Current LifeSpace user is not authorized for platform administration",
      status,
      error?.requestId ?? requestId(request),
    );
  }
  const token = stringValue(dataRecord(issued.payload)?.actorToken);
  if (!token) return failure("IDENTITY_RESPONSE_INVALID", "Identity returned an invalid platform-admin proof", 502, requestId(request));
  return token;
}

async function sessionRoute(request: Request, env: Env): Promise<Response> {
  const session = await exchangeAccess(request, env);
  if (session instanceof Response) return session;
  if (session.status === "unlinked") {
    return json({
      data: {
        status: "unlinked",
        environment: environment(env),
        registrationAvailable: environment(env) === "staging",
        message: "This Cloudflare Access principal is not linked to a LifeSpace user. LifeSpace will not create or merge an account by email automatically.",
      },
    }, 409);
  }
  return json({
    data: {
      status: "linked",
      environment: environment(env),
      user: session.user,
      consoleVersion: CONSOLE_VERSION,
    },
  });
}

async function platformProbeRoute(request: Request, env: Env): Promise<Response> {
  const session = await exchangeAccess(request, env);
  if (session instanceof Response) return session;
  if (session.status === "unlinked") {
    return failure("ACCESS_PRINCIPAL_UNLINKED", "Cloudflare Access principal must be explicitly linked before platform administration", 409, requestId(request));
  }

  const actor = await issueActorProof(request, env, session.userToken);
  if (actor instanceof Response) return actor;

  let applicationCredential: string;
  let coreExecutor: string;
  try {
    applicationCredential = requiredSecret(env.IDENTITY_APPLICATION_CREDENTIAL, "IDENTITY_APPLICATION_CREDENTIAL");
    coreExecutor = requiredSecret(env.CORE_EXECUTOR_BEARER, "CORE_EXECUTOR_BEARER");
  } catch {
    return failure("CONSOLE_NOT_CONFIGURED", "Console platform executors are not configured", 503, requestId(request));
  }

  const [identityStatus, coreStatus, applications, identityAudit, spaces, coreAudit, models] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/status"),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/status"),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/applications", {
      headers: {
        authorization: `Bearer ${applicationCredential}`,
        "x-lifespace-actor-token": actor,
        accept: "application/json",
      },
    }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/audit?limit=1", {
      headers: {
        authorization: `Bearer ${applicationCredential}`,
        "x-lifespace-actor-token": actor,
        accept: "application/json",
      },
    }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/spaces?limit=1", {
      headers: {
        authorization: `Bearer ${coreExecutor}`,
        "x-lifespace-actor-token": actor,
        accept: "application/json",
      },
    }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/audit?limit=1", {
      headers: {
        authorization: `Bearer ${coreExecutor}`,
        "x-lifespace-actor-token": actor,
        accept: "application/json",
      },
    }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/model-admin/models", {
      headers: { authorization: `Bearer ${coreExecutor}`, accept: "application/json" },
    }),
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
  const applicationRows = isRecord(applications.payload) && Array.isArray(applications.payload.data) ? applications.payload.data : [];
  const modelRows = isRecord(models.payload) && Array.isArray(models.payload.data) ? models.payload.data : [];

  return json({
    data: {
      ok: true,
      environment: environment(env),
      user: session.user,
      consoleVersion: CONSOLE_VERSION,
      contracts: {
        identity: stringValue(identityStatusData?.contractVersion),
        identityPlatformAdmin: IDENTITY_PLATFORM_ADMIN_CONTRACT,
        coreKernel: stringValue(coreStatusData?.contractVersion),
        corePlatformAdmin: CORE_PLATFORM_ADMIN_CONTRACT,
      },
      schemas: {
        identity: identityStatusData?.schemaVersion ?? null,
        core: coreStatusData?.schemaVersion ?? null,
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
        provingShell: true,
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/api/session") return sessionRoute(request, env);
  if (request.method === "POST" && url.pathname === "/api/session/register") return registerAccessUser(request, env);
  if (request.method === "GET" && url.pathname === "/api/platform/probe") return platformProbeRoute(request, env);
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

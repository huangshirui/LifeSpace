import downstreamWorker from "./agent-governance";

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
type AdminContext = { actorToken: string; identityCredential: string; coreExecutor: string };
const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const MAX_INSPECTOR_RESULTS = 200;

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
function requestId(request: Request): string {
  return request.headers.get("cf-ray") ?? crypto.randomUUID();
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
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
  const code = stringValue(payload.error.code);
  const message = stringValue(payload.error.message);
  if (!code || !message) return null;
  const upstreamRequestId = stringValue(payload.error.requestId) ?? undefined;
  return { code, message, ...(upstreamRequestId ? { requestId: upstreamRequestId } : {}) };
}
function upstreamFailure(request: Request, result: UpstreamResult, fallbackCode: string, fallbackMessage: string): Response {
  const error = upstreamError(result.payload);
  const allowed = new Set([400, 401, 403, 404, 409, 422, 429, 503]);
  return failure(error?.code ?? fallbackCode, error?.message ?? fallbackMessage, allowed.has(result.response.status) ? result.response.status : 502, error?.requestId ?? requestId(request));
}
function accessAssertion(request: Request): string | null {
  const value = request.headers.get(ACCESS_ASSERTION_HEADER)?.trim() ?? "";
  return value && value.length <= 32768 && value.split(".").length === 3 ? value : null;
}
function environment(env: Env): "local" | "staging" | "production" {
  return env.ENVIRONMENT === "production" ? "production" : env.ENVIRONMENT === "staging" ? "staging" : "local";
}

async function adminContext(request: Request, env: Env): Promise<AdminContext | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));
  const identityCredential = env.IDENTITY_APPLICATION_CREDENTIAL?.trim();
  const coreExecutor = env.CORE_EXECUTOR_BEARER?.trim();
  if (!identityCredential || !coreExecutor) return failure("CONSOLE_NOT_CONFIGURED", "Console Platform Admin executors are not configured", 503, requestId(request));
  const exchange = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/access/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${identityCredential}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read"] }),
  });
  if (exchange.response.status !== 200) return upstreamFailure(request, exchange, "ACCESS_EXCHANGE_FAILED", "LifeSpace Identity rejected the Access assertion");
  const userToken = stringValue(dataRecord(exchange.payload)?.accessToken);
  if (!userToken) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid user session", 502, requestId(request));
  const proof = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${userToken}`, accept: "application/json" },
  });
  if (proof.response.status !== 200) return upstreamFailure(request, proof, "PLATFORM_ADMIN_PROOF_DENIED", "Current LifeSpace user is not authorized for platform administration");
  const actorToken = stringValue(dataRecord(proof.payload)?.actorToken);
  if (!actorToken) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid Platform Admin actor proof", 502, requestId(request));
  return { actorToken, identityCredential, coreExecutor };
}

function identityHeaders(context: AdminContext): HeadersInit {
  return { authorization: `Bearer ${context.identityCredential}`, "x-lifespace-actor-token": context.actorToken, accept: "application/json" };
}
function coreHeaders(context: AdminContext): HeadersInit {
  return { authorization: `Bearer ${context.coreExecutor}`, "x-lifespace-actor-token": context.actorToken, accept: "application/json" };
}
function sourcedAudit(payload: unknown, source: "identity" | "core"): JsonRecord[] | null {
  const rows = dataArray(payload);
  if (!rows) return null;
  return rows.filter(isRecord).map((row) => ({ ...row, source }));
}

async function overview(request: Request, env: Env): Promise<Response> {
  const context = await adminContext(request, env);
  if (context instanceof Response) return context;
  const [identityStatus, coreStatus, applications, users, spaces, identityAudit, coreAudit, models] = await Promise.all([
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/api/v1/status"),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/status"),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/applications", { headers: identityHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/users?limit=${MAX_INSPECTOR_RESULTS}`, { headers: identityHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, `/api/v1/platform-admin/spaces?limit=${MAX_INSPECTOR_RESULTS}`, { headers: coreHeaders(context) }),
    serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, "/internal/v1/platform-admin/audit?limit=8", { headers: identityHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/audit?limit=8", { headers: coreHeaders(context) }),
    serviceRequest(env.CORE, env.CORE_BASE_URL, "/api/v1/platform-admin/models", { headers: coreHeaders(context) }),
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
    return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace control plane returned an invalid overview response", 502, requestId(request));
  }
  const recentAudit = [...identityAuditRows, ...coreAuditRows]
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")))
    .slice(0, 10);
  return json({ data: {
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
  } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/overview" && !url.search) return overview(request, env);
    return downstreamWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

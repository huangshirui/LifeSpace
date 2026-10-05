import applicationConfigurationWorker from "./application-configuration";

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
type RevealPayload = { kind: "application-credential" | "service-token" | "agent-credential"; secret: string; label: string };
type RevealEnvelope = RevealPayload & { expiresAt: number };

const ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const INTENT_HEADER = "x-lifespace-console-intent";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SCOPES = 64;
const REVEAL_PATH = "/api/credential-reveal";
const REVEAL_TTL_MS = 60_000;
const REVEAL_AAD = "lifespace-console-target-credential-reveal-v1";

const intents = {
  createApplicationCredential: "create-application-credential",
  revokeApplicationCredential: "revoke-application-credential",
  createServicePrincipal: "create-service-principal",
  updateServicePrincipal: "update-service-principal",
  createServiceToken: "create-service-token",
  updateServiceToken: "update-service-token",
  revokeServiceToken: "revoke-service-token",
  createAgentCredential: "create-agent-api-credential",
  updateAgentCredential: "update-agent-api-credential",
  revokeAgentCredential: "revoke-agent-api-credential",
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

async function requireIdentityAdminContext(request: Request, env: Env): Promise<IdentityAdminContext | Response> {
  const assertion = accessAssertion(request);
  if (!assertion) return failure("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access assertion is required", 401, requestId(request));
  const identityCredential = env.IDENTITY_APPLICATION_CREDENTIAL?.trim() ?? "";
  if (!identityCredential.startsWith("lsa_")) return failure("CONSOLE_NOT_CONFIGURED", "Console Identity executor is not configured", 503, requestId(request));

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

function validApplicationId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u.test(value); }
function validCredentialId(value: string): boolean { return /^apc_[A-Za-z0-9_-]+$/u.test(value); }
function validPrincipalId(value: string): boolean { return /^svc_[A-Za-z0-9_-]+$/u.test(value); }
function validTokenId(value: string): boolean { return /^sat_[A-Za-z0-9_-]+$/u.test(value); }
function validAgentId(value: string): boolean { return /^agt_[A-Za-z0-9_-]+$/u.test(value); }
function validAgentCredentialId(value: string): boolean { return /^agc_[A-Za-z0-9_-]+$/u.test(value); }

function normalizeScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) return null;
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return null;
    const scope = item.trim();
    if (!scope || scope.length > 100 || /\s/u.test(scope)) return null;
    if (!seen.has(scope)) { seen.add(scope); scopes.push(scope); }
  }
  return scopes;
}

function allowlist(data: JsonRecord, keys: string[]): JsonRecord {
  return Object.fromEntries(keys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

function sanitizeCredential(data: JsonRecord): JsonRecord {
  return allowlist(data, ["id", "applicationId", "secretSuffix", "status", "createdAt", "revokedAt"]);
}

function sanitizePrincipal(data: JsonRecord): JsonRecord {
  return allowlist(data, ["id", "applicationId", "displayName", "description", "maxScopes", "status", "createdByUserId", "createdAt", "updatedAt", "disabledAt"]);
}

function sanitizeToken(data: JsonRecord): JsonRecord {
  return allowlist(data, ["id", "principalId", "displayPrefix", "lastFour", "label", "scopes", "audience", "expiresAt", "createdAt", "createdByUserId", "lastUsedAt", "revokedAt"]);
}

function sanitizeAgentCredential(data: JsonRecord): JsonRecord {
  return allowlist(data, ["id", "agentId", "applicationId", "displayPrefix", "lastFour", "label", "scopes", "audience", "status", "expiresAt", "createdAt", "createdByUserId", "lastUsedAt", "revokedAt", "revokedByUserId"]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return null; }
}

async function deriveRevealKey(env: Env): Promise<CryptoKey> {
  const identityCredential = env.IDENTITY_APPLICATION_CREDENTIAL?.trim() ?? "";
  if (!identityCredential.startsWith("lsa_")) throw new Error("IDENTITY_APPLICATION_CREDENTIAL is not configured");
  const material = new TextEncoder().encode(`${REVEAL_AAD}\u0000${env.ENVIRONMENT}\u0000${identityCredential}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealReveal(env: Env, payload: RevealPayload): Promise<string> {
  const key = await deriveRevealKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope: RevealEnvelope = { ...payload, expiresAt: Date.now() + REVEAL_TTL_MS };
  const plaintext = new TextEncoder().encode(JSON.stringify(envelope));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: new TextEncoder().encode(REVEAL_AAD),
  }, key, plaintext));
  const sealed = new Uint8Array(iv.length + ciphertext.length);
  sealed.set(iv, 0);
  sealed.set(ciphertext, iv.length);
  return bytesToBase64Url(sealed);
}

async function openReveal(env: Env, ticket: string): Promise<RevealPayload | null> {
  const sealed = base64UrlToBytes(ticket);
  if (!sealed || sealed.length <= 12 || sealed.length > 16_384) return null;
  const key = await deriveRevealKey(env);
  try {
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv: sealed.slice(0, 12),
      additionalData: new TextEncoder().encode(REVEAL_AAD),
    }, key, sealed.slice(12));
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
    if (!isRecord(decoded) || typeof decoded.expiresAt !== "number" || !Number.isFinite(decoded.expiresAt)) return null;
    if (decoded.expiresAt < Date.now() || decoded.expiresAt > Date.now() + REVEAL_TTL_MS + 5_000) return null;
    const kind = decoded.kind;
    const secret = stringValue(decoded.secret);
    const label = stringValue(decoded.label);
    if ((kind !== "application-credential" && kind !== "service-token" && kind !== "agent-credential") || !secret || !label) return null;
    if (kind === "application-credential" && !secret.startsWith("lsa_")) return null;
    if (kind === "service-token" && !secret.startsWith("lsp_svc_")) return null;
    if (kind === "agent-credential" && !secret.startsWith("lsp_agt_")) return null;
    return { kind, secret, label };
  } catch { return null; }
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/g, "&quot;").replace(/'/gu, "&#39;");
}

function revealHtml(payload: RevealPayload | null): string {
  if (!payload) return "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Credential unavailable</title></head><body><main><h1>Credential unavailable</h1><p>The short-lived reveal ticket has expired or is invalid. Revoke the unrecovered credential and create a replacement.</p></main></body></html>";
  const kindLabel = payload.kind === "application-credential" ? "Application credential" : payload.kind === "service-token" ? "Service API Token" : "Agent API credential";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(kindLabel)}</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#f5f7fb;color:#15233b}main{max-width:820px;margin:8vh auto;padding:28px;background:white;border:1px solid #dfe6f0;border-radius:16px;box-shadow:0 20px 60px rgba(20,40,75,.12)}h1{font-size:24px;margin:0 0 8px}p{color:#5f6f86;line-height:1.55}label{display:block;margin-top:22px;font-size:12px;font-weight:700;color:#40516d}textarea{box-sizing:border-box;width:100%;min-height:112px;margin-top:8px;padding:14px;border:1px solid #cdd8e6;border-radius:10px;background:#f9fbfe;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}.note{margin-top:18px;padding:12px;border-radius:10px;background:#fff7e8;color:#72561b;font-size:12px}</style></head><body><main><h1>${escapeHtml(kindLabel)}</h1><p>${escapeHtml(payload.label)}</p><label>Copy now</label><textarea readonly spellcheck="false">${escapeHtml(payload.secret)}</textarea><div class="note">This isolated reveal document contains no JavaScript and is not cacheable. The encrypted reveal ticket expires quickly; store the credential in the target system and close this tab.</div></main></body></html>`;
}

function revealHeaders(): Headers {
  return new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
}

function onlyRevealTicket(url: URL): string | null {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "ticket" || url.searchParams.getAll("ticket").length !== 1) return null;
  const ticket = url.searchParams.get("ticket") ?? "";
  return ticket.length >= 32 && ticket.length <= 16_384 ? ticket : null;
}

async function credentialReveal(request: Request, env: Env): Promise<Response> {
  const ticket = onlyRevealTicket(new URL(request.url));
  if (!ticket) return new Response(revealHtml(null), { status: 410, headers: revealHeaders() });
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return new Response(revealHtml(null), { status: context.status, headers: revealHeaders() });
  const payload = await openReveal(env, ticket);
  return new Response(revealHtml(payload), { status: payload ? 200 : 410, headers: revealHeaders() });
}

async function revealPath(env: Env, payload: RevealPayload): Promise<string> {
  const ticket = await sealReveal(env, payload);
  return `${REVEAL_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

async function createApplicationCredential(request: Request, env: Env, applicationId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createApplicationCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "confirmApplicationId") || body.confirmApplicationId !== applicationId) {
    return failure("CONFIRMATION_REQUIRED", "Credential creation requires exact application confirmation", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/credentials`, {
    method: "POST", headers: identityHeaders(context),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "APPLICATION_CREDENTIAL_CREATE_FAILED", "Application credential creation failed");
  const created = dataRecord(result.payload);
  const secret = created ? stringValue(created.clientSecret) : null;
  if (!created || !secret?.startsWith("lsa_")) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity did not return a valid one-time application credential", 502, requestId(request));
  let path: string;
  try { path = await revealPath(env, { kind: "application-credential", secret, label: `Application ${applicationId}` }); }
  catch { return failure("CREDENTIAL_REVEAL_HANDOFF_FAILED", "Credential was created but its secure reveal handoff could not be sealed. Revoke it and create a replacement.", 502, requestId(request)); }
  return json({ data: { credential: sanitizeCredential(created), revealPath: path } }, 201);
}

async function revokeApplicationCredential(request: Request, env: Env, applicationId: string, credentialId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.revokeApplicationCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "confirmApplicationId" && key !== "confirmCredentialId") || body.confirmApplicationId !== applicationId || body.confirmCredentialId !== credentialId) {
    return failure("CONFIRMATION_REQUIRED", "Credential revocation requires exact application and credential confirmation", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE", headers: identityHeaders(context),
  });
  if (result.response.status !== 204) return upstreamFailure(request, result, "APPLICATION_CREDENTIAL_REVOKE_FAILED", "Application credential revocation failed");
  return json({ data: { applicationId, credentialId, revoked: true } });
}

async function createServicePrincipal(request: Request, env: Env, applicationId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createServicePrincipal);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["displayName", "description", "maxScopes", "confirmApplicationId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId) return failure("CONFIRMATION_REQUIRED", "Service principal creation requires exact application confirmation", 422, requestId(request));
  const displayName = stringValue(body.displayName)?.trim() ?? "";
  const description = body.description === null ? null : typeof body.description === "string" ? body.description.trim() || null : null;
  const maxScopes = normalizeScopes(body.maxScopes);
  if (!displayName || displayName.length > 100 || (description?.length ?? 0) > 500 || !maxScopes) return failure("VALIDATION_ERROR", "Service principal fields are invalid", 422, requestId(request));
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/service-principals`, {
    method: "POST", headers: identityHeaders(context, true), body: JSON.stringify({ displayName, description, maxScopes }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "SERVICE_PRINCIPAL_CREATE_FAILED", "Service principal creation failed");
  const created = dataRecord(result.payload);
  return created ? json({ data: sanitizePrincipal(created) }, 201) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid service principal", 502, requestId(request));
}

async function updateServicePrincipal(request: Request, env: Env, applicationId: string, principalId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateServicePrincipal);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["displayName", "description", "maxScopes", "status", "confirmApplicationId", "confirmPrincipalId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmPrincipalId !== principalId) return failure("CONFIRMATION_REQUIRED", "Service principal update requires exact application and principal confirmation", 422, requestId(request));
  const patch: JsonRecord = {};
  if (body.displayName !== undefined) {
    const value = stringValue(body.displayName)?.trim() ?? "";
    if (!value || value.length > 100) return failure("VALIDATION_ERROR", "displayName must contain 1-100 characters", 422, requestId(request));
    patch.displayName = value;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") return failure("VALIDATION_ERROR", "description must be string or null", 422, requestId(request));
    const value = typeof body.description === "string" ? body.description.trim() : null;
    if ((value?.length ?? 0) > 500) return failure("VALIDATION_ERROR", "description may contain at most 500 characters", 422, requestId(request));
    patch.description = value || null;
  }
  if (body.maxScopes !== undefined) {
    const scopes = normalizeScopes(body.maxScopes);
    if (!scopes) return failure("VALIDATION_ERROR", "maxScopes are invalid", 422, requestId(request));
    patch.maxScopes = scopes;
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return failure("VALIDATION_ERROR", "status must be active or disabled", 422, requestId(request));
    patch.status = body.status;
  }
  if (!Object.keys(patch).length) return failure("INVALID_REQUEST", "At least one mutable principal field is required", 400, requestId(request));
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principalId)}`, {
    method: "PATCH", headers: identityHeaders(context, true), body: JSON.stringify(patch),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "SERVICE_PRINCIPAL_UPDATE_FAILED", "Service principal update failed");
  const updated = dataRecord(result.payload);
  return updated ? json({ data: sanitizePrincipal(updated) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned an invalid service principal", 502, requestId(request));
}

async function listServiceTokens(request: Request, env: Env, applicationId: string, principalId: string): Promise<Response> {
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principalId)}/tokens`, {
    headers: identityHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "SERVICE_TOKEN_LIST_FAILED", "Service token metadata lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows.filter(isRecord).map(sanitizeToken) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid token metadata", 502, requestId(request));
}

async function createServiceToken(request: Request, env: Env, applicationId: string, principalId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createServiceToken);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["label", "scopes", "expiresAt", "confirmApplicationId", "confirmPrincipalId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmPrincipalId !== principalId) return failure("CONFIRMATION_REQUIRED", "Service token creation requires exact application and principal confirmation", 422, requestId(request));
  const label = stringValue(body.label)?.trim() ?? "";
  const scopes = normalizeScopes(body.scopes);
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : null;
  if (!label || label.length > 100 || !scopes || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) return failure("VALIDATION_ERROR", "Service token fields are invalid", 422, requestId(request));
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principalId)}/tokens`, {
    method: "POST", headers: identityHeaders(context, true), body: JSON.stringify({ label, scopes, expiresAt }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "SERVICE_TOKEN_CREATE_FAILED", "Service API Token creation failed");
  const created = dataRecord(result.payload);
  const secret = created ? stringValue(created.token) : null;
  if (!created || !secret?.startsWith("lsp_svc_")) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity did not return a valid one-time Service API Token", 502, requestId(request));
  let path: string;
  try { path = await revealPath(env, { kind: "service-token", secret, label: `${label} (${principalId})` }); }
  catch { return failure("CREDENTIAL_REVEAL_HANDOFF_FAILED", "Service API Token was created but its secure reveal handoff could not be sealed. Revoke it and create a replacement.", 502, requestId(request)); }
  return json({ data: { token: sanitizeToken(created), revealPath: path } }, 201);
}

async function updateServiceToken(request: Request, env: Env, applicationId: string, principalId: string, tokenId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateServiceToken);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["label", "scopes", "expiresAt", "confirmApplicationId", "confirmPrincipalId", "confirmTokenId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmPrincipalId !== principalId || body.confirmTokenId !== tokenId) return failure("CONFIRMATION_REQUIRED", "Service token update requires exact application, principal and token confirmation", 422, requestId(request));
  const patch: JsonRecord = {};
  if (body.label !== undefined) {
    const label = stringValue(body.label)?.trim() ?? "";
    if (!label || label.length > 100) return failure("VALIDATION_ERROR", "label must contain 1-100 characters", 422, requestId(request));
    patch.label = label;
  }
  if (body.scopes !== undefined) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes) return failure("VALIDATION_ERROR", "scopes are invalid", 422, requestId(request));
    patch.scopes = scopes;
  }
  if (body.expiresAt !== undefined) {
    const expiresAt = body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : undefined;
    if (expiresAt === undefined || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) return failure("VALIDATION_ERROR", "expiresAt must be ISO date-time or null", 422, requestId(request));
    patch.expiresAt = expiresAt;
  }
  if (!Object.keys(patch).length) return failure("INVALID_REQUEST", "At least one mutable token field is required", 400, requestId(request));
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principalId)}/tokens/${encodeURIComponent(tokenId)}`, {
    method: "PATCH", headers: identityHeaders(context, true), body: JSON.stringify(patch),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "SERVICE_TOKEN_UPDATE_FAILED", "Service API Token update failed");
  const updated = dataRecord(result.payload);
  return updated ? json({ data: sanitizeToken(updated) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid token metadata", 502, requestId(request));
}

async function revokeServiceToken(request: Request, env: Env, applicationId: string, principalId: string, tokenId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.revokeServiceToken);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "confirmApplicationId" && key !== "confirmPrincipalId" && key !== "confirmTokenId") || body.confirmApplicationId !== applicationId || body.confirmPrincipalId !== principalId || body.confirmTokenId !== tokenId) {
    return failure("CONFIRMATION_REQUIRED", "Service token revocation requires exact application, principal and token confirmation", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/service-principals/${encodeURIComponent(principalId)}/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE", headers: identityHeaders(context),
  });
  if (result.response.status !== 204) return upstreamFailure(request, result, "SERVICE_TOKEN_REVOKE_FAILED", "Service API Token revocation failed");
  return json({ data: { applicationId, principalId, tokenId, revoked: true } });
}

async function listAgentCredentials(request: Request, env: Env, applicationId: string, agentId: string): Promise<Response> {
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials`, {
    headers: identityHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "AGENT_CREDENTIAL_LIST_FAILED", "Agent API credential metadata lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows.filter(isRecord).map(sanitizeAgentCredential) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent credential metadata", 502, requestId(request));
}

async function createAgentCredential(request: Request, env: Env, applicationId: string, agentId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createAgentCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["label", "scopes", "expiresAt", "confirmApplicationId", "confirmAgentId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId) {
    return failure("CONFIRMATION_REQUIRED", "Agent credential creation requires exact application and Agent confirmation", 422, requestId(request));
  }
  const label = stringValue(body.label)?.trim() ?? "";
  const scopes = normalizeScopes(body.scopes);
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : undefined;
  if (!label || label.length > 100 || !scopes || expiresAt === undefined || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) {
    return failure("VALIDATION_ERROR", "Agent credential fields are invalid", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials`, {
    method: "POST", headers: identityHeaders(context, true), body: JSON.stringify({ label, scopes, expiresAt }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "AGENT_CREDENTIAL_CREATE_FAILED", "Agent API credential creation failed");
  const created = dataRecord(result.payload);
  const secret = created ? stringValue(created.token) : null;
  if (!created || !secret?.startsWith("lsp_agt_")) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity did not return a valid one-time Agent API credential", 502, requestId(request));
  let path: string;
  try { path = await revealPath(env, { kind: "agent-credential", secret, label: `${label} (${agentId})` }); }
  catch { return failure("CREDENTIAL_REVEAL_HANDOFF_FAILED", "Agent API credential was created but its secure reveal handoff could not be sealed. Revoke it and create a replacement.", 502, requestId(request)); }
  return json({ data: { credential: sanitizeAgentCredential(created), revealPath: path } }, 201);
}

async function updateAgentCredential(request: Request, env: Env, applicationId: string, agentId: string, credentialId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateAgentCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["label", "scopes", "expiresAt", "confirmApplicationId", "confirmAgentId", "confirmCredentialId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId || body.confirmCredentialId !== credentialId) {
    return failure("CONFIRMATION_REQUIRED", "Agent credential update requires exact application, Agent and credential confirmation", 422, requestId(request));
  }
  const patch: JsonRecord = {};
  if (body.label !== undefined) {
    const label = stringValue(body.label)?.trim() ?? "";
    if (!label || label.length > 100) return failure("VALIDATION_ERROR", "label must contain 1-100 characters", 422, requestId(request));
    patch.label = label;
  }
  if (body.scopes !== undefined) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes) return failure("VALIDATION_ERROR", "scopes are invalid", 422, requestId(request));
    patch.scopes = scopes;
  }
  if (body.expiresAt !== undefined) {
    const expiresAt = body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : undefined;
    if (expiresAt === undefined || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) return failure("VALIDATION_ERROR", "expiresAt must be ISO date-time or null", 422, requestId(request));
    patch.expiresAt = expiresAt;
  }
  if (!Object.keys(patch).length) return failure("INVALID_REQUEST", "At least one mutable Agent credential field is required", 400, requestId(request));
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials/${encodeURIComponent(credentialId)}`, {
    method: "PATCH", headers: identityHeaders(context, true), body: JSON.stringify(patch),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "AGENT_CREDENTIAL_UPDATE_FAILED", "Agent API credential update failed");
  const updated = dataRecord(result.payload);
  return updated ? json({ data: sanitizeAgentCredential(updated) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent credential metadata", 502, requestId(request));
}

async function revokeAgentCredential(request: Request, env: Env, applicationId: string, agentId: string, credentialId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.revokeAgentCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["confirmApplicationId", "confirmAgentId", "confirmCredentialId"].includes(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId || body.confirmCredentialId !== credentialId) {
    return failure("CONFIRMATION_REQUIRED", "Agent credential revocation requires exact application, Agent and credential confirmation", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE", headers: identityHeaders(context),
  });
  if (result.response.status !== 204) return upstreamFailure(request, result, "AGENT_CREDENTIAL_REVOKE_FAILED", "Agent API credential revocation failed");
  return json({ data: { applicationId, agentId, credentialId, revoked: true } });
}

function parsePath(pathname: string): { applicationId: string; credentialId?: string; principalId?: string; tokenId?: string; agentId?: string; agentCredentialId?: string; resource: "credentials" | "principals" | "tokens" | "agent-credentials" } | null {
  let match = /^\/api\/credential-governance\/applications\/([^/]+)\/credentials(?:\/([^/]+))?$/u.exec(pathname);
  if (match) {
    try {
      const applicationId = decodeURIComponent(match[1]);
      const credentialId = match[2] ? decodeURIComponent(match[2]) : undefined;
      if (!validApplicationId(applicationId) || (credentialId && !validCredentialId(credentialId))) return null;
      return { applicationId, credentialId, resource: "credentials" };
    } catch { return null; }
  }
  match = /^\/api\/credential-governance\/applications\/([^/]+)\/agents\/([^/]+)\/api-credentials(?:\/([^/]+))?$/u.exec(pathname);
  if (match) {
    try {
      const applicationId = decodeURIComponent(match[1]);
      const agentId = decodeURIComponent(match[2]);
      const agentCredentialId = match[3] ? decodeURIComponent(match[3]) : undefined;
      if (!validApplicationId(applicationId) || !validAgentId(agentId) || (agentCredentialId && !validAgentCredentialId(agentCredentialId))) return null;
      return { applicationId, agentId, agentCredentialId, resource: "agent-credentials" };
    } catch { return null; }
  }
  match = /^\/api\/credential-governance\/applications\/([^/]+)\/service-principals(?:\/([^/]+))?(?:\/tokens(?:\/([^/]+))?)?$/u.exec(pathname);
  if (!match) return null;
  try {
    const applicationId = decodeURIComponent(match[1]);
    const principalId = match[2] ? decodeURIComponent(match[2]) : undefined;
    const tokenId = match[3] ? decodeURIComponent(match[3]) : undefined;
    if (!validApplicationId(applicationId) || (principalId && !validPrincipalId(principalId)) || (tokenId && !validTokenId(tokenId))) return null;
    return { applicationId, principalId, tokenId, resource: pathname.includes("/tokens") ? "tokens" : "principals" };
  } catch { return null; }
}

async function configurationCenterRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === REVEAL_PATH) return credentialReveal(request, env);
  const target = parsePath(url.pathname);
  if (!target) return null;

  if (target.resource === "credentials") {
    if (request.method === "POST" && !target.credentialId) return createApplicationCredential(request, env, target.applicationId);
    if (request.method === "DELETE" && target.credentialId) return revokeApplicationCredential(request, env, target.applicationId, target.credentialId);
  }
  if (target.resource === "agent-credentials" && target.agentId) {
    if (request.method === "GET" && !target.agentCredentialId) return listAgentCredentials(request, env, target.applicationId, target.agentId);
    if (request.method === "POST" && !target.agentCredentialId) return createAgentCredential(request, env, target.applicationId, target.agentId);
    if (request.method === "PATCH" && target.agentCredentialId) return updateAgentCredential(request, env, target.applicationId, target.agentId, target.agentCredentialId);
    if (request.method === "DELETE" && target.agentCredentialId) return revokeAgentCredential(request, env, target.applicationId, target.agentId, target.agentCredentialId);
  }
  if (target.resource === "principals") {
    if (request.method === "POST" && !target.principalId) return createServicePrincipal(request, env, target.applicationId);
    if (request.method === "PATCH" && target.principalId) return updateServicePrincipal(request, env, target.applicationId, target.principalId);
  }
  if (target.resource === "tokens" && target.principalId) {
    if (request.method === "GET" && !target.tokenId) return listServiceTokens(request, env, target.applicationId, target.principalId);
    if (request.method === "POST" && !target.tokenId) return createServiceToken(request, env, target.applicationId, target.principalId);
    if (request.method === "PATCH" && target.tokenId) return updateServiceToken(request, env, target.applicationId, target.principalId, target.tokenId);
    if (request.method === "DELETE" && target.tokenId) return revokeServiceToken(request, env, target.applicationId, target.principalId, target.tokenId);
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const response = await configurationCenterRoute(request, env);
      if (response) return response;
      return applicationConfigurationWorker.fetch(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        message: "LifeSpace Console Configuration Center request failed",
        requestId: requestId(request),
        path: new URL(request.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return failure("INTERNAL_ERROR", "LifeSpace Console Configuration Center request failed", 500, requestId(request));
    }
  },
} satisfies ExportedHandler<Env>;

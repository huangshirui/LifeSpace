import externalConnectionsWorker from "./external-connections";

// Console BFF; never exposes Identity credentials or platform actor proof to
// browsers. Identity remains the authoritative OAuth registration policy store.
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
const PATH = "/api/oauth-client-admission";
const UPSTREAM = "/internal/v1/platform-admin/oauth/client-admission";
const INTENT = "update-oauth-client-admission";

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" },
  });
}
const fail = (code: string, message: string, status: number) => response({ error: { code, message } }, status);
function value(data: unknown, key: string): string | null {
  return data && typeof data === "object" && !Array.isArray(data)
    && typeof (data as Record<string, unknown>)[key] === "string"
    ? (data as Record<string, string>)[key] : null;
}
async function upstream(env: Env, path: string, init: RequestInit): Promise<Response> {
  const url = new URL(path, env.IDENTITY_BASE_URL);
  const req = new Request(url, init);
  return env.IDENTITY ? env.IDENTITY.fetch(req) : fetch(req);
}
async function parse(res: Response): Promise<unknown> {
  return res.json().catch(() => null);
}
async function forward(request: Request, env: Env): Promise<Response> {
  const uri = new URL(request.url);
  if (uri.search) return fail("INVALID_REQUEST", "Unexpected query parameters", 400);
  const mutate = request.method === "PUT";
  if (!mutate && request.method !== "GET") return fail("METHOD_NOT_ALLOWED", "Unsupported request method", 405);
  if (mutate && (request.headers.get("origin") !== uri.origin
    || request.headers.get("sec-fetch-site") !== "same-origin"
    || request.headers.get("x-lifespace-console-intent") !== INTENT
    || !/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") || ""))) {
    return fail("INVALID_BROWSER_MUTATION", "Save requires same-origin user intent", 403);
  }
  const assertion = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!assertion || assertion.length > 32768 || assertion.split(".").length !== 3) {
    return fail("ACCESS_ASSERTION_REQUIRED", "Cloudflare Access login required", 401);
  }
  const credential = env.IDENTITY_APPLICATION_CREDENTIAL?.trim();
  if (!credential) return fail("CONSOLE_NOT_CONFIGURED", "Identity admin executor is unavailable", 503);

  let body: string | undefined;
  if (mutate) {
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 16384) return fail("REQUEST_TOO_LARGE", "Policy exceeds 16 KiB", 413);
    // Identity validates exact URLs, revision and all rule types. The BFF
    // accepts only a JSON object and never forwards arbitrary unbounded bytes.
    try {
      const obj: unknown = JSON.parse(body);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
    } catch { return fail("INVALID_REQUEST", "JSON policy object required", 400); }
  }

  const exchanged = await upstream(env, "/internal/v1/access/tokens", {
    method: "POST",
    headers: { authorization: "Bearer " + credential, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ accessAssertion: assertion, requestedScopes: ["profile:read"] }),
  });
  const exchange = await parse(exchanged);
  if (!exchanged.ok) return fail("ACCESS_EXCHANGE_FAILED", "Access principal not authenticated", exchanged.status);
  const userToken = exchange && typeof exchange === "object" && !Array.isArray(exchange)
    ? value((exchange as Record<string, unknown>).data, "accessToken") : null;
  if (!userToken) return fail("INVALID_IDENTITY_RESPONSE", "Missing user token", 502);

  const proofResponse = await upstream(env, "/api/v1/me/platform-admin-actor-token", {
    method: "POST", headers: { authorization: "Bearer " + userToken, accept: "application/json" },
  });
  const proof = await parse(proofResponse);
  if (!proofResponse.ok) return fail("PLATFORM_ADMIN_PROOF_DENIED", "Platform administrator permission required", proofResponse.status);
  const actorToken = proof && typeof proof === "object" && !Array.isArray(proof)
    ? value((proof as Record<string, unknown>).data, "actorToken") : null;
  if (!actorToken) return fail("INVALID_IDENTITY_RESPONSE", "Missing admin proof", 502);

  const result = await upstream(env, UPSTREAM, {
    method: mutate ? "PUT" : "GET",
    headers: {
      authorization: "Bearer " + credential, "x-lifespace-actor-token": actorToken,
      accept: "application/json", ...(mutate ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  const payload = await parse(result);
  const data = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null;
  if (result.ok && data && "data" in data) return response({ data: data.data });
  if (!result.ok) {
    const err = data?.error && typeof data.error === "object" && !Array.isArray(data.error)
      ? data.error as Record<string, unknown> : {};
    return fail(
      typeof err.code === "string" ? err.code : "IDENTITY_ADMISSION_FAILED",
      typeof err.message === "string" ? err.message : "Identity rejected OAuth admission update",
      [400, 401, 403, 409, 413, 422, 429, 503].includes(result.status) ? result.status : 502,
    );
  }
  return fail("INVALID_IDENTITY_RESPONSE", "Invalid OAuth admission response", 502);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== PATH) return externalConnectionsWorker.fetch(request, env);
    try { return await forward(request, env); }
    catch {
      return fail("ADMISSION_UNAVAILABLE", "OAuth client admission management unavailable", 503);
    }
  },
} satisfies ExportedHandler<Env>;

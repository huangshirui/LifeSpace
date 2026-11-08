// Real public-wire negative tests against a NON-PRODUCTION staging OAuth/MCP stack.
// Makes no successful OAuth registration/consent or database mutations.
// Never uses an existing OAuth bearer/refresh token, user cookie, or real user data.
import { randomBytes, createHash } from "node:crypto";

const expectEnv = (name) => {
  const value = process.env[name];
  if (!value) throw Error(name + " must point to a configured Staging endpoint");
  return value;
};
const issuerInput = expectEnv("MCP_STAGING_ISSUER");
const resourceInput = expectEnv("MCP_STAGING_RESOURCE");
const issuer = new URL(issuerInput);
const resource = new URL(resourceInput);
if (issuer.protocol !== "https:" || issuer.pathname !== "/" || issuer.search || issuer.hash
  || issuer.hostname !== "auth-staging.aisr.online"
  || resource.protocol !== "https:" || resource.hostname !== "core-staging.aisr.online"
  || !/^\/mcp\/mcp_[a-f0-9]{32}$/u.test(resource.pathname) || resource.search || resource.hash) {
  throw Error("Staging-only hosts and exact published MCP Server required");
}

function assert(predicate, label) { if (!predicate) throw Error("FAIL: " + label); }
const summary = [];
async function call(label, url, init = {}, expectedStatus, expectedError) {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: { accept: "application/json", ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  assert(response.status === expectedStatus, label + " returned unexpected HTTP " + response.status);
  if (expectedError) assert(body?.error === expectedError, label + " error code mismatch");
  summary.push({ test: label, http: response.status, passed: true });
  return { response, body };
}
const form = values => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values),
});
const rpc = bearer => ({
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: "staging-wire", method: "tools/list", params: {} }),
});

// Actual Staging issuer and resource, not synthetic/mocked responses.
const metadata = await call("oauth_server_metadata", issuer.origin + "/.well-known/oauth-authorization-server", {}, 200);
assert(metadata.body?.issuer === issuer.origin, "unexpected OAuth issuer");
assert(metadata.body?.authorization_endpoint === issuer.origin + "/oauth/authorize", "unexpected authorize endpoint");
assert(metadata.body?.token_endpoint === issuer.origin + "/oauth/token", "unexpected token endpoint");
assert(metadata.body?.revocation_endpoint === issuer.origin + "/oauth/revoke", "unexpected revoke endpoint");
assert(metadata.body?.code_challenge_methods_supported?.includes("S256"), "S256 PKCE must be advertised");
const protectedResource = resource.origin + "/.well-known/oauth-protected-resource" + resource.pathname;
const protectedMeta = await call("protected_resource_metadata", protectedResource, {}, 200);
assert(protectedMeta.body?.resource === resource.href, "exact resource URI mismatch");
assert(protectedMeta.body?.authorization_servers?.includes(issuer.origin), "protected resource issuer mismatch");

const challenge = await call("missing_bearer_rejected", resource.href, rpc(), 401);
assert(challenge.response.headers.get("www-authenticate")?.includes("Bearer"),
  "missing Bearer WWW-Authenticate challenge");
const forgedBearer = "lsp_oat_" + randomBytes(32).toString("base64url");
await call("forged_bearer_rejected", resource.href, rpc(forgedBearer), 401);
const unknownServer = resource.origin + "/mcp/mcp_" + "b".repeat(32);
if (unknownServer !== resource.href) await call("unknown_mcp_server_rejected", unknownServer, rpc(), 404);

const validChallenge = createHash("sha256").update("a".repeat(64)).digest("base64url");
const base = {
  response_type: "code",
  client_id: "ocli_ghost_synthetic_no_registration",
  redirect_uri: "https://client.example.test/callback",
  resource: resource.href,
  state: "staging-fail-closed-state-123456789",
  code_challenge: validChallenge,
  code_challenge_method: "S256",
};
function authorize(overrides) {
  const url = new URL("/oauth/authorize", issuer);
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value !== null) url.searchParams.set(key, value);
  }
  return url.href;
}
await call("missing_state_rejected", authorize({ state: null }), {}, 400, "invalid_request");
await call("pkce_plain_rejected", authorize({ code_challenge_method: "plain" }), {}, 400, "invalid_request");
await call("invalid_pkce_challenge_rejected", authorize({ code_challenge: "not-S256" }), {}, 400, "invalid_request");
await call("unregistered_resource_rejected", authorize({
  resource: resource.origin + "/mcp/mcp_" + "c".repeat(32),
}), {}, 400, "invalid_request");
await call("unknown_oauth_client_rejected", authorize({}), {}, 400, "invalid_client");

// The public CIMD client used by the current Staging ChatGPT connection is already
// registered. Alter just the callback PATH on the same HTTPS origin: exact URI
// matching must reject it before persisting an Authorization Request.
await call("registered_client_wrong_callback_path_rejected", authorize({
  client_id: "https://chatgpt.com/oauth/client.json",
  redirect_uri: "https://chatgpt.com/connector/oauth/unregistered-path-staging-negative",
}), {}, 400, "invalid_request");

// Intentionally invalid registration must NOT create a Client.
await call("invalid_redirect_registration_rejected", issuer.origin + "/oauth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Staging negative validation",
    redirect_uris: ["javascript:alert(1)"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"] }),
}, 400, "invalid_redirect_uri");
await call("unknown_token_client_rejected", issuer.origin + "/oauth/token",
  form({ grant_type: "authorization_code", client_id: "ocli_ghost_synthetic_no_registration",
    code: "lsp_oac_" + randomBytes(32).toString("base64url"),
    redirect_uri: base.redirect_uri, code_verifier: "a".repeat(64) }), 401, "invalid_client");
// A registered public Client must also reject a syntactically plausible but
// never-issued Refresh Token. This proves invalid-token denial, NOT replay of a
// real consumed Refresh Token (which requires a dedicated live consent).
await call("registered_client_fake_refresh_token_rejected", issuer.origin + "/oauth/token",
  form({ grant_type: "refresh_token",
    client_id: "https://chatgpt.com/oauth/client.json",
    refresh_token: "lsp_ort_" + randomBytes(32).toString("base64url"),
    resource: resource.href }), 400, "invalid_grant");
await call("private_introspection_secret_required", issuer.origin + "/oauth/introspect",
  form({ token: forgedBearer, resource: resource.href }), 401, "invalid_client");

// No valid authorization, callback, token or data was created or revoked.
console.log(JSON.stringify({ ok: true, target: "Staging OAuth/MCP public-wire",
  tests: summary, consentTested: false, refreshRotationTested: false,
  liveAuthenticatedCrossSpaceTested: false, dataMutated: false }));

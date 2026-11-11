// Readable, repeatable LIVE staging acceptance for the public OAuth boundary.
// Invoked only by the owner-dispatched staging acceptance workflow. No user
// credentials or browser cookies are used; no Production calls are possible.
// Creates ONE public test client and ONE unapproved request, then deletes only
// those exact IDs via scoped staging D1 access even when a later assertion fails.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const BASE = "https://auth-staging.aisr.online";
const CORE_ORIGIN = "https://core-staging.aisr.online";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
assert.ok(/^[a-f0-9]{32}$/.test(accountId || ""), "Staging Cloudflare account ID required");
assert.ok(apiToken, "Staging-scoped Cloudflare API token required");
const nonce = randomUUID().replaceAll("-", "");
const callback = `https://oauth-acceptance.example.org/callback/${nonce}`;
const pkceVerifier = "staging-acceptance-" + randomUUID().replaceAll("-", "") + "X".repeat(30);
const codeChallenge = createHash("sha256").update(pkceVerifier).digest("base64url");
let ownedClientId = null;
let ownedRequestId = null;
const outcomes = [];

function passed(name) {
  outcomes.push(name);
  console.log("PASS: " + name);
}
function bodyJson(value) {
  return JSON.stringify(value);
}
async function request(path, init = {}) {
  const url = new URL(path, BASE);
  assert.equal(url.origin, BASE, "No other public service is a test target");
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(12000),
    headers: { "user-agent": "LifeSpace-Staging-OAuth-Acceptance/1.0", ...init.headers },
    ...init,
  });
  return response;
}
async function api(sql, params = []) {
  assert.ok(/^\s*(SELECT|DELETE)\b/i.test(sql), "Only scoped reads or cleanup deletes allowed");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${process.env.IDENTITY_STAGING_D1_ID}/query`;
  assert.ok(/^[0-9a-f-]{36}$/.test(process.env.IDENTITY_STAGING_D1_ID || ""), "Staging Identity D1 ID required");
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: bodyJson({ sql, params }),
  });
  const data = await response.json();
  if (!response.ok || data.success !== true || !data.result?.[0]?.success) {
    throw new Error(`Cloudflare D1 test query failed with HTTP ${response.status}`);
  }
  return data.result[0].results ?? [];
}
async function coreApi(sql) {
  const coreId = process.env.CORE_STAGING_D1_ID;
  assert.ok(/^[0-9a-f-]{36}$/.test(coreId || ""), "Staging Core D1 ID required");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${coreId}/query`;
  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: bodyJson({ sql }),
  });
  const data = await response.json();
  if (!response.ok || data.success !== true || !data.result?.[0]?.success) {
    throw new Error("Cannot discover active staging MCP resources");
  }
  return data.result[0].results ?? [];
}
function authorizeUrl(clientId, redirect, resource, overrides = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    resource,
    response_type: "code",
    scope: "resources:read",
    state: "oauth-staging-" + nonce,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    ...overrides,
  });
  return "/oauth/authorize?" + params.toString();
}
async function cleanup() {
  if (ownedRequestId) {
    await api(
      "DELETE FROM oauth_authorization_requests WHERE id=? AND client_id=? "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorizations a WHERE a.request_id=?)",
      [ownedRequestId, ownedClientId, ownedRequestId],
    );
  }
  if (ownedClientId) {
    await api(
      "DELETE FROM oauth_clients WHERE id=? AND id LIKE 'ocli_%' "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorization_requests r WHERE r.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorizations a WHERE a.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes c WHERE c.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id=?)",
      Array(6).fill(ownedClientId),
    );
    const leftover = await api("SELECT count(*) AS total FROM oauth_clients WHERE id=?", [ownedClientId]);
    assert.equal(leftover[0]?.total, 0, "Ephemeral staging Client cleanup failed");
  }
  passed("ephemeral OAuth test records cleaned");
}
async function run() {
  const metadataResponse = await request("/.well-known/oauth-authorization-server");
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.issuer, BASE);
  assert.equal(metadata.registration_endpoint, BASE + "/oauth/register");
  assert.ok(metadata.code_challenge_methods_supported?.includes("S256"));
  assert.equal(metadata.client_id_metadata_document_supported, undefined,
    "Unverified CIMD egress must remain disabled");
  passed("server metadata and CIMD fail-closed");

  // Public invalid client metadata must fail before any D1 registration.
  const invalidRedirect = await request("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: bodyJson({ client_name: "invalid", redirect_uris: ["https://*.example.org/callback"] }),
  });
  assert.equal(invalidRedirect.status, 400);
  passed("DCR wildcard callback rejected");

  const invalidAuthMethod = await request("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: bodyJson({ redirect_uris: [callback], token_endpoint_auth_method: "client_secret_post" }),
  });
  assert.equal(invalidAuthMethod.status, 400);
  passed("DCR confidential token method rejected");

  const oversized = await request("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: bodyJson({ redirect_uris: [callback], note: "x".repeat(9000) }),
  });
  assert.equal(oversized.status, 400);
  passed("DCR oversized request rejected");

  const registered = await request("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: bodyJson({
      client_name: "LifeSpace staging acceptance (unverified)",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    }),
  });
  assert.equal(registered.status, 201, "DCR registration did not succeed");
  const client = await registered.json();
  assert.match(client.client_id, /^ocli_[a-f0-9]{32}$/);
  assert.deepEqual(client.redirect_uris, [callback]);
  ownedClientId = client.client_id;
  passed("real DCR auto-registration");

  const resources = await coreApi(
    "SELECT id FROM mcp_server_definitions WHERE enabled=1 ORDER BY updated_at DESC LIMIT 10",
  );
  assert.ok(resources.length > 0, "No enabled staging MCP server to accept OAuth");
  let accepted = null;
  let resource = "";
  for (const row of resources) {
    if (!/^mcp_[a-f0-9]{32}$/.test(row.id)) continue;
    const candidate = `${CORE_ORIGIN}/mcp/${row.id}`;
    const attempt = await request(authorizeUrl(ownedClientId, callback, candidate));
    if (attempt.status === 302) {
      accepted = attempt;
      resource = candidate;
      break;
    }
    assert.equal(attempt.status, 400, "Unexpected OAuth authorization response");
  }
  assert.ok(accepted, "No enabled MCP resource accepted a valid read-scope OAuth request");
  const consent = new URL(accepted.headers.get("location"));
  assert.equal(consent.origin, "https://account-staging.aisr.online");
  ownedRequestId = consent.searchParams.get("request_id");
  assert.match(ownedRequestId || "", /^oar_[a-f0-9]{32}$/);
  assert.equal(consent.searchParams.has("code"), false);
  passed("PKCE S256 + live MCP resource reaches pending Account Consent");

  const pending = await api(
    "SELECT status FROM oauth_authorization_requests WHERE id=? AND client_id=?",
    [ownedRequestId, ownedClientId],
  );
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  const granted = await api("SELECT count(*) AS total FROM oauth_authorizations WHERE request_id=?", [ownedRequestId]);
  assert.equal(granted[0]?.total, 0);
  passed("pending consent creates no Authorization");

  const wrongCallback = await request(authorizeUrl(ownedClientId, "https://attacker.example.net/callback", resource));
  assert.equal(wrongCallback.status, 400);
  passed("unregistered OAuth redirect rejected");

  const invalidPkce = await request(authorizeUrl(ownedClientId, callback, resource, {
    code_challenge_method: "plain",
  }));
  assert.equal(invalidPkce.status, 400);
  passed("non-S256 OAuth PKCE rejected");

  const cimdAttempt = await request(authorizeUrl(
    "https://untrusted-public.example.org/client.json", callback, resource,
  ));
  assert.equal(cimdAttempt.status, 400);
  passed("unapproved CIMD URL does not initiate metadata discovery");

  const wrongCode = await request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ownedClientId,
      code: "lsp_oac_invalid",
      code_verifier: pkceVerifier,
      redirect_uri: callback,
      resource,
    }).toString(),
  });
  assert.equal(wrongCode.status, 400);
  passed("invalid authorization code cannot mint token");

  const unauthorizedIntrospection = await request("/oauth/introspect", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: "lsp_oat_not_valid", resource }).toString(),
  });
  assert.equal(unauthorizedIntrospection.status, 401);
  passed("OAuth token introspection requires resource-server authentication");
}
let failed = null;
try {
  await run();
} catch (error) {
  failed = error;
  console.error("OAuth staging security acceptance failed: " + (error?.message ?? String(error)));
} finally {
  try {
    await cleanup();
  } catch (error) {
    failed ||= error;
    console.error("OAuth staging acceptance cleanup failed: " + (error?.message ?? String(error)));
  }
}
console.log(`Security acceptance checks passed: ${outcomes.length}; status: ${failed ? "FAILED" : "PASSED"}`);
if (failed) process.exitCode = 1;

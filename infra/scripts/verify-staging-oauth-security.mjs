// Readable, repeatable LIVE staging acceptance for the public OAuth boundary.
// Invoked only by the owner-dispatched staging acceptance workflow. No user
// credentials or browser cookies are used; no Production calls are possible.
// Owner-gated real Staging checks, including a CIMD-only deployment gate.
// No user session, consent approval or token minting is requested. Cleanup
// owns only the exact nonce-bound requests and unreferenced test registrations.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { APPROVED_STAGING_CIMD_IDS, auditCimdStaging } from "./audit-staging-cimd-egress.mjs";

const BASE = "https://auth-staging.aisr.online";
const CORE_ORIGIN = "https://core-staging.aisr.online";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const stagingD1 = { identity: null, core: null };
async function discoverStagingDatabases() {
  for (const [service, worker] of [
    ["identity", "lifespace-identity-staging"],
    ["core", "lifespace-core-staging"],
  ]) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/settings`,
      {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    const data = await response.json();
    assert.ok(response.ok && data.success, `Cannot verify ${service} staging Worker`);
    const binding = data.result?.bindings?.find(b => b.type === "d1" && b.name === "DB");
    assert.match(binding?.id || "", /^[a-f0-9-]{36}$/, "Missing staging D1 binding");
    stagingD1[service] = binding.id;
  }
}
assert.ok(/^[a-f0-9]{32}$/.test(accountId || ""), "Staging Cloudflare account ID required");
assert.ok(apiToken, "Staging-scoped Cloudflare API token required");
const nonce = randomUUID().replaceAll("-", "");
const callback = `https://oauth-acceptance.example.org/callback/${nonce}`;
const pkceVerifier = "staging-acceptance-" + randomUUID().replaceAll("-", "") + "X".repeat(30);
const codeChallenge = createHash("sha256").update(pkceVerifier).digest("base64url");
let ownedClientId = null;
let ownedRequestId = null;
const outcomes = [];
const ownedFixtureClients = [];
const cimdOnly = process.argv.includes("--cimd-only");
const CIMD_CHATGPT = APPROVED_STAGING_CIMD_IDS[0];
const CIMD_FIXTURE = APPROVED_STAGING_CIMD_IDS[1];
const CIMD_CALLBACKS = {
  [CIMD_CHATGPT]: "https://chatgpt.com/connector_platform_oauth_redirect",
  [CIMD_FIXTURE]: "https://oauth-acceptance.example.org/callback",
};

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
  assert.ok(stagingD1.identity, "Identity staging D1 binding not verified");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${stagingD1.identity}/query`;
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
  const coreId = stagingD1.core;
  assert.ok(coreId, "Core staging D1 binding not verified");
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
  // No database discovery means no request or registration was created.
  if (!stagingD1.identity) return;
  // Delete only the nonce-bound, still-pending requests created by this run.
  for (const clientId of APPROVED_STAGING_CIMD_IDS) {
    await api(
      "DELETE FROM oauth_authorization_requests WHERE client_id=? AND state=? AND status='pending' "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorizations a WHERE a.request_id=oauth_authorization_requests.id)",
      [clientId, "oauth-staging-" + nonce],
    );
    const leftover = await api(
      "SELECT count(*) AS total FROM oauth_authorization_requests WHERE client_id=? AND state=?",
      [clientId, "oauth-staging-" + nonce],
    );
    assert.equal(leftover[0]?.total, 0, "Owned CIMD request cleanup failed");
  }
  // Never delete a pre-existing vendor registration or any referenced row.
  // A newly discovered official ChatGPT registration is intentionally retained
  // as a legitimate stable client. The synthetic fixture alone may be deleted.
  for (const clientId of ownedFixtureClients) {
    assert.equal(clientId, CIMD_FIXTURE);
    await api(
      "DELETE FROM oauth_clients WHERE id=? "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorization_requests r WHERE r.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorizations a WHERE a.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes c WHERE c.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id=?)",
      Array(6).fill(clientId),
    );
  }
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
async function runCimd() {
  const audit = await auditCimdStaging({ accountId, token: apiToken });
  assert.ok(audit.safe, "CIMD network and deployment configuration is not safe");
  await discoverStagingDatabases();
  const res = await request("/.well-known/oauth-authorization-server");
  assert.equal(res.status, 200);
  const metadata = await res.json();
  assert.equal(metadata.issuer, BASE);
  if (audit.safeClosed) {
    assert.equal(metadata.client_id_metadata_document_supported, undefined);
    passed("CIMD release switch closed; no discovery advertised");
    return false;
  }
  assert.equal(metadata.client_id_metadata_document_supported, true, "CIMD pilot is not advertised");
  assert.equal(metadata.registration_endpoint, BASE + "/oauth/register");
  assert.ok(metadata.code_challenge_methods_supported?.includes("S256"));
  assert.ok(!metadata.grant_types_supported?.includes("urn:ietf:params:oauth:grant-type:jwt-bearer"));
  passed("CIMD pilot advertised alongside DCR, not JWT bearer");
  const resources = await coreApi(
    "SELECT id FROM mcp_server_definitions WHERE enabled=1 ORDER BY updated_at DESC LIMIT 10",
  );
  assert.ok(resources.length > 0, "No enabled Staging MCP resource for real CIMD acceptance");
  let selectedResource;
  for (const clientId of APPROVED_STAGING_CIMD_IDS) {
    const registeredBefore = await api("SELECT id,status FROM oauth_clients WHERE id=?", [clientId]);
    if (clientId === CIMD_FIXTURE && registeredBefore.length === 0) ownedFixtureClients.push(clientId);
    let accepted;
    for (const row of resources) {
      if (!/^mcp_[a-f0-9]{32}$/u.test(row.id)) continue;
      const resource = CORE_ORIGIN + "/mcp/" + row.id;
      const attempt = await request(authorizeUrl(clientId, CIMD_CALLBACKS[clientId], resource));
      if (attempt.status === 302) {
        accepted = attempt;
        selectedResource = resource;
        break;
      }
      assert.equal(attempt.status, 400, "Unexpected CIMD authorization response");
    }
    assert.ok(accepted, "No eligible MCP resource accepted pinned CIMD client " + clientId);
    const consent = new URL(accepted.headers.get("location"));
    const requestId = consent.searchParams.get("request_id");
    assert.match(requestId || "", /^oar_[a-f0-9]{32}$/u);
    assert.equal(consent.origin, "https://account-staging.aisr.online");
    assert.equal(consent.searchParams.has("code"), false);
    const pending = await api(
      "SELECT status,state,redirect_uri FROM oauth_authorization_requests WHERE id=? AND client_id=?",
      [requestId, clientId],
    );
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, "pending");
    assert.equal(pending[0].state, "oauth-staging-" + nonce);
    assert.equal(pending[0].redirect_uri, CIMD_CALLBACKS[clientId]);
    const granted = await api("SELECT count(*) AS total FROM oauth_authorizations WHERE request_id=?", [requestId]);
    assert.equal(granted[0]?.total, 0);
    passed("real pinned CIMD pending Consent (no Authorization): " + clientId);
    const wrong = await request(authorizeUrl(clientId,
      "https://oauth-acceptance.example.org/not-registered", selectedResource));
    assert.equal(wrong.status, 400);
    passed("pinned CIMD rejects an unregistered redirect: " + clientId);
  }
  const unlisted = "https://untrusted-public.example.org/client.json";
  const rejected = await request(authorizeUrl(unlisted, CIMD_CALLBACKS[CIMD_FIXTURE], selectedResource));
  assert.equal(rejected.status, 400);
  const denied = await rejected.json();
  assert.equal(denied.error, "invalid_client");
  const unlistedRows = await api("SELECT count(*) AS total FROM oauth_clients WHERE id=?", [unlisted]);
  assert.equal(unlistedRows[0]?.total, 0, "Unlisted CIMD client was persisted");
  passed("unlisted CIMD rejected without client registration");
  const forbidden = await request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: CIMD_CHATGPT,
      assertion: "not-a-jwt",
    }).toString(),
  });
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).error, "unsupported_grant_type");
  passed("JWT bearer declaration does not enable JWT bearer token exchange");
  return true;
}
async function run() {
  if (cimdOnly) { await runCimd(); return; }
  const cimdEnabled = await runCimd();
  const metadataResponse = await request("/.well-known/oauth-authorization-server");
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.issuer, BASE);
  assert.equal(metadata.registration_endpoint, BASE + "/oauth/register");
  assert.ok(metadata.code_challenge_methods_supported?.includes("S256"));
  assert.equal(metadata.client_id_metadata_document_supported, cimdEnabled ? true : undefined,
    "CIMD discovery must reflect the audited deployment switch");
  passed("server metadata matches bounded CIMD release state");

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
  passed("unapproved CIMD URL rejected");

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

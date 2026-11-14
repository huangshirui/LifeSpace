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
const cimdOnly = process.argv.includes("--cimd-only");
const allowDisabled = process.argv.includes("--allow-disabled");
const cimdFixture = "https://cdn.jsdelivr.net/gh/huangshirui/LifeSpace@main/infra/cimd-network-probe/client.json";
const cimdOfficial = "https://chatgpt.com/oauth/client.json";
const cimdCases = [
  [cimdFixture, "https://oauth-acceptance.example.org/callback"],
  [cimdOfficial, "https://chatgpt.com/connector_platform_oauth_redirect"],
];
let fixtureWasAbsent = false;
const cimdState = "oauth-staging-" + nonce;

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
  if (!stagingD1.identity) return;
  // Exact client IDs and this run's random state. Never delete a vendor
  // registration, an approved authorization, or another session's request.
  for (const [clientId] of cimdCases) {
    await api(
      "DELETE FROM oauth_authorization_requests WHERE client_id=? AND state=? AND status='pending' "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorizations a WHERE a.request_id=oauth_authorization_requests.id)",
      [clientId, cimdState],
    );
    const leftover = await api(
      "SELECT count(*) AS total FROM oauth_authorization_requests WHERE client_id=? AND state=?",
      [clientId, cimdState],
    );
    assert.equal(leftover[0]?.total, 0, "Owned CIMD request cleanup failed");
  }
  if (fixtureWasAbsent) {
    await api(
      "DELETE FROM oauth_clients WHERE id=? "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorization_requests r WHERE r.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorizations a WHERE a.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_authorization_codes c WHERE c.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens a WHERE a.client_id=?) "
      + "AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens r WHERE r.client_id=?)",
      Array(6).fill(cimdFixture),
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
async function verifyConsoleDiscovery() {
  const policy = (await api("SELECT cimd_enabled,dcr_enabled FROM oauth_client_admission_policy WHERE id=1"))[0];
  assert.ok(policy && [0,1].includes(policy.cimd_enabled) && [0,1].includes(policy.dcr_enabled), "Console admission policy missing");
  const response = await request("/.well-known/oauth-authorization-server");
  assert.equal(response.status,200);
  const metadata = await response.json();
  assert.equal(metadata.issuer,BASE);
  assert.equal(metadata.client_id_metadata_document_supported, policy.cimd_enabled ? true : undefined);
  assert.equal(metadata.registration_endpoint, policy.dcr_enabled ? BASE+"/oauth/register" : undefined);
  passed("Both discovery capabilities match the current Console policy");
  if (!policy.dcr_enabled) {
    const denied = await request("/oauth/register",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({redirect_uris:[callback]})});
    assert.equal(denied.status,403);
    passed("Console-disabled DCR rejects new registrations");
  }
  return {policy,metadata};
}
async function runCimd() {
  await discoverStagingDatabases();
  const {policy,metadata}=await verifyConsoleDiscovery();
  if (!policy.cimd_enabled) {
    assert.ok(allowDisabled, "CIMD disabled in Staging Console; enable it before positive acceptance");
    const denied=await request(authorizeUrl(cimdFixture,cimdCases[0][1],CORE_ORIGIN+"/mcp/mcp_"+"0".repeat(32)));
    assert.equal(denied.status,400);
    console.log("CIMD positive acceptance NOT RUN: Console policy is off. Enable in Console, then run the manual verification workflow.");
    return;
  }
  assert.ok(metadata.code_challenge_methods_supported?.includes("S256"));
  assert.ok(!metadata.grant_types_supported?.includes("urn:ietf:params:oauth:grant-type:jwt-bearer"));
  passed("CIMD discovery advertised without enabling new token grant types");
  const resources = await coreApi("SELECT id FROM mcp_server_definitions WHERE enabled=1 ORDER BY updated_at DESC LIMIT 10");
  assert.ok(resources.length > 0, "No enabled staging MCP resource for CIMD");
  const existing = await api("SELECT id FROM oauth_clients WHERE id=?", [cimdFixture]);
  fixtureWasAbsent = existing.length === 0;
  let selectedResource;
  for (const [clientId, redirect] of cimdCases) {
    let accepted;
    for (const row of resources) {
      if (!/^mcp_[a-f0-9]{32}$/u.test(row.id)) continue;
      const resource = CORE_ORIGIN + "/mcp/" + row.id;
      const attempt = await request(authorizeUrl(clientId, redirect, resource));
      if (attempt.status === 302) {
        accepted = attempt;
        selectedResource = resource;
        break;
      }
      assert.equal(attempt.status, 400, "Unexpected CIMD authorization response");
      const denial = await attempt.json().catch(()=>null);
      const known = ["invalid_client","invalid_request","temporarily_unavailable","rate_limited"];
      const category = known.includes(denial?.error) ? denial.error : "other";
      console.log("CIMD admission rejected: host="+new URL(clientId).hostname+" oauth_error="+category);
    }
    assert.ok(accepted, "No eligible resource accepted CIMD document: " + new URL(clientId).hostname);
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
    assert.equal(pending[0].state, cimdState);
    assert.equal(pending[0].redirect_uri, redirect);
    const granted = await api("SELECT count(*) AS total FROM oauth_authorizations WHERE request_id=?", [requestId]);
    assert.equal(granted[0]?.total, 0);
    passed("CIMD real pending Consent without authorization: " + new URL(clientId).hostname);
    // Live cache acceptance without granting a real User authorization.
    // A publisher may intentionally send noncacheable metadata; report that
    // case as not verified rather than pretending a cache hit succeeded.
    const freshness = await api(
      "SELECT m.redirect_uris,m.policy_revision,m.fresh_until_ms,p.revision FROM oauth_cimd_metadata_cache m JOIN oauth_client_admission_policy p ON p.id=1 WHERE m.client_id=?",
      [clientId],
    );
    if (freshness[0]?.fresh_until_ms > Date.now()) {
      assert.ok(freshness[0].fresh_until_ms <= Date.now()+300_000);
      assert.equal(freshness[0].policy_revision,freshness[0].revision);
      assert.ok(JSON.parse(freshness[0].redirect_uris).includes(redirect));
      const repeated = await request(authorizeUrl(clientId,redirect,selectedResource));
      assert.equal(repeated.status,302);
      const after = await api("SELECT fresh_until_ms FROM oauth_cimd_metadata_cache WHERE client_id=?",[clientId]);
      assert.equal(after[0]?.fresh_until_ms,freshness[0].fresh_until_ms,
        "Reading fresh CIMD metadata must not renew its freshness");
      passed("CIMD live bounded HTTP freshness reuse: "+new URL(clientId).hostname);
    } else {
      console.log("CIMD live freshness NOT VERIFIED: publisher response not cacheable or freshness expired: "+new URL(clientId).hostname);
    }
    const wrong = await request(authorizeUrl(clientId, "https://oauth-acceptance.example.org/not-registered", selectedResource));
    assert.equal(wrong.status, 400);
    passed("CIMD exact callback denial: " + new URL(clientId).hostname);
  }
  const privateId = "https://127.0.0.1.sslip.io/cimd-test";
  const rejected = await request(authorizeUrl(privateId, cimdCases[0][1], selectedResource));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, "invalid_client");
  assert.equal((await api("SELECT count(*) AS total FROM oauth_clients WHERE id=?", [privateId]))[0]?.total, 0);
  passed("Private DNS CIMD target denied before persistence");
  const unsupported = await request("/oauth/token", {
    method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id:cimdOfficial,assertion:"not-a-jwt"}).toString(),
  });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error, "unsupported_grant_type");
  passed("Extra client grant declarations never enable new token exchange");
}
async function run() {
  if (cimdOnly) { await runCimd(); return; }
  await discoverStagingDatabases();
  const {policy,metadata}=await verifyConsoleDiscovery();
  if (!policy.dcr_enabled) {
    console.log("DCR positive acceptance NOT RUN: Console policy is off.");
    if (policy.cimd_enabled) await runCimd();
    return;
  }
  assert.ok(metadata.code_challenge_methods_supported?.includes("S256"));
  assert.ok(metadata.client_id_metadata_document_supported === undefined
    || metadata.client_id_metadata_document_supported === true);
  passed("server metadata and registration state");
  // The canonical owner deployment runs the separate CIMD-only live suite.
  // This legacy DCR suite need not re-run the already validated CIMD tests.

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
    "https://127.0.0.1.sslip.io/cimd-test", callback, resource,
  ));
  assert.equal(cimdAttempt.status, 400);
  passed("private-DNS CIMD URL does not create a usable registration");

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
  if (policy.cimd_enabled) await runCimd();
  else console.log("CIMD positive acceptance NOT RUN: Console policy is off.");
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

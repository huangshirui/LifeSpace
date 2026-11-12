// Canonical read-only MCP Staging ingress probe (never a live OAuth/data test).
// No OAuth client, Access cookies, secrets, mutations or user data.
import process from "node:process";
import { pathToFileURL } from "node:url";

const CORE_ORIGIN = "https://core-staging.aisr.online";
const IDENTITY_ISSUER = "https://auth-staging.aisr.online";
const INIT = JSON.stringify({
  jsonrpc: "2.0", id: "canonical-staging-probe", method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {},
    clientInfo: { name: "lifespace-staging-mcp-probe", version: "0.0.0" } },
});
const INVALID_TOKEN = "lsp_oat_" + "invalidsynthetic".repeat(4);

export function canonicalStagingResource(value) {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("Explicit canonical Core Staging MCP Resource URI is required");
  }
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid MCP Staging Resource URI"); }
  const allowedPath = new RegExp("^/mcp/mcp_[a-f0-9]{32}$", "u").test(url.pathname);
  if (url.origin !== CORE_ORIGIN || !allowedPath || url.username || url.password
    || url.search || url.hash || url.href !== value) {
    throw new Error("Probe accepts only exact core-staging.aisr.online/mcp/{mcp_*}");
  }
  return url;
}
function assert(value, message) { if (!value) throw new Error(message); }

async function responseJson(fetcher, url) {
  const response = await fetcher(url, {
    method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok && payload && typeof payload === "object", "Unavailable Staging metadata at " + new URL(url).pathname);
  return payload;
}

export async function verifyCanonicalMcpStagingWire({ resourceUri, fetcher = fetch } = {}) {
  const uri = canonicalStagingResource(resourceUri);
  const metadataUri = CORE_ORIGIN + "/.well-known/oauth-protected-resource" + uri.pathname;
  const issuer = await responseJson(fetcher, IDENTITY_ISSUER + "/.well-known/oauth-authorization-server");
  assert(issuer.issuer === IDENTITY_ISSUER
    && issuer.authorization_endpoint === IDENTITY_ISSUER + "/oauth/authorize"
    && issuer.token_endpoint === IDENTITY_ISSUER + "/oauth/token"
    && issuer.code_challenge_methods_supported?.includes("S256"),
  "Identity Staging OAuth issuer or PKCE metadata mismatch");

  const resource = await responseJson(fetcher, metadataUri);
  assert(resource.resource === uri.href
    && Array.isArray(resource.authorization_servers)
    && resource.authorization_servers.length === 1
    && resource.authorization_servers[0] === IDENTITY_ISSUER
    && resource.scopes_supported?.includes("resources:read")
    && resource.bearer_methods_supported?.includes("header"),
  "Per-Server RFC 9728 metadata did not match the Core Staging Resource");

  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const none = await fetcher(uri.href, {
    method: "POST", headers, body: INIT, signal: AbortSignal.timeout(10000),
  });
  const challenge = none.headers.get("www-authenticate") || "";
  assert(none.status === 401 && /^Bearer\s/u.test(challenge)
    && challenge.includes('resource_metadata="' + metadataUri + '"'),
  "MCP missing-token response must be a 401 Bearer challenge for this exact Server (not an Access redirect)");

  const invalid = await fetcher(uri.href, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer " + INVALID_TOKEN },
    body: INIT, signal: AbortSignal.timeout(10000),
  });
  assert(invalid.status === 401, "MCP accepted an unissued synthetic OAuth access token");
  return {
    ok: true, stagingOnly: true, mutations: false, userDataRead: false,
    resource: uri.href, resourceMetadata: metadataUri, issuer: IDENTITY_ISSUER,
    exactServerMetadataVerified: true, missingTokenRejected: true,
    forgedTokenRejected: true, oauthConsentVerified: false,
    tokenExchangeVerified: false, coreQueryVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyCanonicalMcpStagingWire({
    resourceUri: process.env.LIFESPACE_STAGING_MCP_RESOURCE_URI,
  });
  console.log(JSON.stringify(result, null, 2));
}

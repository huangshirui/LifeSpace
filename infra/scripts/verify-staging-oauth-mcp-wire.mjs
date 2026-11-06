// Read-only, staging-only public OAuth/MCP wire probe.
// No client registration, OAuth grant, secrets, Access cookies, or business data.
// A passing probe verifies protected-resource *entry*, never Core data Authority.
import process from "node:process";
import { pathToFileURL } from "node:url";

const STAGING_ISSUER = "https://auth-staging.aisr.online";
const SYNTHETIC_TOKEN = "lsp_oat_" + "invalidsynthetic".repeat(4);
const INIT = JSON.stringify({
  jsonrpc: "2.0", id: "staging-probe",
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lifespace-staging-probe", version: "0.0.0" } },
});

export function stagingMcpResource(value) {
  if (typeof value !== "string" || value.length > 300) throw new Error("Explicit Staging-only MCP Resource URI required");
  let uri;
  try { uri = new URL(value); } catch { throw new Error("Invalid Staging MCP Resource URI"); }
  // A deliberately separate experimental Resource is allowed; the agreed
  // per-server Core /mcp/{serverId} routing is NOT implemented by this probe.
  // Never probe or mutate a production resource by a typo in an env var.
  if (uri.protocol !== "https:" || uri.username || uri.password || uri.search || uri.hash
    || uri.pathname !== "/mcp" || !uri.hostname.endsWith("-staging.aisr.online")
    || uri.href !== value) throw new Error("Only an exact isolated Staging /mcp URI is accepted");
  return uri;
}

function ensure(value, message) { if (!value) throw new Error(message); }
async function requestJson(fetcher, url, init) {
  const response = await fetcher(url, init);
  const payload = await response.json().catch(() => null);
  ensure(response.ok && payload && typeof payload === "object", "Staging OAuth metadata unavailable: " + new URL(url).pathname);
  return payload;
}

export async function verifyStagingMcpOAuthWire({ resourceUri, fetcher = fetch } = {}) {
  const uri = stagingMcpResource(resourceUri);
  const resource = uri.href;
  const metadataUri = uri.origin + "/.well-known/oauth-protected-resource/mcp";
  const settings = { method: "GET", signal: AbortSignal.timeout(10000), headers: { accept: "application/json" } };
  const authorization = await requestJson(fetcher, STAGING_ISSUER + "/.well-known/oauth-authorization-server", settings);
  ensure(authorization.issuer === STAGING_ISSUER
    && authorization.authorization_endpoint === STAGING_ISSUER + "/oauth/authorize"
    && authorization.token_endpoint === STAGING_ISSUER + "/oauth/token"
    && Array.isArray(authorization.code_challenge_methods_supported)
    && authorization.code_challenge_methods_supported.includes("S256"),
  "Identity metadata does not advertise the expected Staging PKCE Authorization Server");

  const protectedResource = await requestJson(fetcher, metadataUri, settings);
  ensure(protectedResource.resource === resource
    && Array.isArray(protectedResource.authorization_servers)
    && protectedResource.authorization_servers.length === 1
    && protectedResource.authorization_servers[0] === STAGING_ISSUER
    && Array.isArray(protectedResource.bearer_methods_supported)
    && protectedResource.bearer_methods_supported.includes("header")
    && Array.isArray(protectedResource.scopes_supported)
    && protectedResource.scopes_supported.includes("resources:read"),
  "MCP Protected Resource metadata mismatch; no cross-Resource acceptance");

  const rpcHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const noCredential = await fetcher(resource, {
    method: "POST", headers: rpcHeaders, body: INIT, signal: AbortSignal.timeout(10000),
  });
  const challenge = noCredential.headers.get("www-authenticate") || "";
  ensure(noCredential.status === 401 && /^Bearer\s/u.test(challenge)
    && challenge.includes('resource_metadata="' + metadataUri + '"'),
  "MCP must challenge a missing Bearer with the exact Resource metadata (not a login page or Core response)");

  const forged = await fetcher(resource, {
    method: "POST", headers: { ...rpcHeaders, authorization: "Bearer " + SYNTHETIC_TOKEN },
    body: INIT, signal: AbortSignal.timeout(10000),
  });
  ensure(forged.status === 401, "MCP must reject synthetic unissued OAuth credentials");
  return {
    ok: true, stagingOnly: true, noMutations: true, liveUserDataRead: false,
    issuer: STAGING_ISSUER, resource, metadataUri,
    authorizationCodePkceAdvertised: true, absentTokenRejected: true, forgedTokenRejected: true,
    // NOT an OAuth consent/token exchange, current Agent Core query, or MCP Server config acceptance.
    endToEndOAuthVerified: false, coreDataExecutionVerified: false, serverIdRoutingVerified: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyStagingMcpOAuthWire({
    resourceUri: process.env.LIFESPACE_STAGING_MCP_RESOURCE_URI,
  });
  console.log(JSON.stringify(result, null, 2));
}

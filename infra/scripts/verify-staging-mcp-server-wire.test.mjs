import test from "node:test";
import assert from "node:assert/strict";
import { canonicalStagingResource, verifyCanonicalMcpStagingWire } from "./verify-staging-mcp-server-wire.mjs";

const origin = "https://core-staging.aisr.online";
const uri = origin + "/mcp/mcp_" + "a".repeat(32);
const metadata = origin + "/.well-known/oauth-protected-resource/mcp/mcp_" + "a".repeat(32);
const issuer = "https://auth-staging.aisr.online";

function stub({ wrongResource = false, badChallenge = false, acceptInvalid = false } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, headers: new Headers(init.headers) });
    if (url === issuer + "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer, authorization_endpoint: issuer + "/oauth/authorize",
        token_endpoint: issuer + "/oauth/token", code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === metadata) {
      return Response.json({
        resource: wrongResource ? origin + "/mcp/mcp_" + "b".repeat(32) : uri,
        authorization_servers: [issuer], scopes_supported: ["resources:read"],
        bearer_methods_supported: ["header"],
      });
    }
    if (url === uri && init.method === "POST") {
      if (new Headers(init.headers).has("authorization")) {
        return Response.json({ error: "invalid_token" }, { status: acceptInvalid ? 200 : 401 });
      }
      return new Response(null, {
        status: badChallenge ? 302 : 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="' + metadata + '", scope="resources:read"' },
      });
    }
    throw new Error("Unexpected URL " + url);
  };
  return { calls, fetcher };
}
test("accepts only exact Core Staging mcp_* Resource, before any network request", () => {
  assert.equal(canonicalStagingResource(uri).href, uri);
  for (const invalid of [
    "", undefined, origin + "/mcp", origin + "/mcp/mcp_fake",
    origin + "/mcp/mcp_" + "a".repeat(32) + "/",
    uri + "?debug=1", uri + "#secret",
    "https://core.aisr.online/mcp/mcp_" + "a".repeat(32),
    "http://core-staging.aisr.online/mcp/mcp_" + "a".repeat(32),
    "https://evil.example.test/mcp/mcp_" + "a".repeat(32),
  ]) assert.throws(() => canonicalStagingResource(invalid));
});
test("canonical per-Server metadata and Bearer challenges, no secrets or data", async () => {
  const { calls, fetcher } = stub();
  const result = await verifyCanonicalMcpStagingWire({ resourceUri: uri, fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.coreQueryVerified, false);
  assert.equal(result.oauthConsentVerified, false);
  assert.deepEqual(calls.map(x => x.method), ["GET", "GET", "POST", "POST"]);
  assert.ok(calls.every(c => !c.headers.has("cookie")));
  assert.equal(calls[3].headers.get("authorization")?.startsWith("Bearer lsp_oat_"), true);
});
test("mismatch/redirect/forged-token acceptance fail the probe closed", async () => {
  for (const options of [{ wrongResource: true }, { badChallenge: true }, { acceptInvalid: true }]) {
    await assert.rejects(verifyCanonicalMcpStagingWire({ resourceUri: uri, fetcher: stub(options).fetcher }));
  }
});
test("invalid Production target never performs even a metadata GET", async () => {
  let requests = 0;
  await assert.rejects(verifyCanonicalMcpStagingWire({
    resourceUri: "https://core.aisr.online/mcp/mcp_" + "a".repeat(32),
    fetcher: async () => { requests++; throw new Error("should not call"); },
  }));
  assert.equal(requests, 0);
});

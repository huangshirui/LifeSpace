import test from "node:test";
import assert from "node:assert/strict";
import { stagingMcpResource, verifyStagingMcpOAuthWire } from "./verify-staging-oauth-mcp-wire.mjs";

const URI = "https://example-mcp-staging.aisr.online/mcp";
const META = "https://example-mcp-staging.aisr.online/.well-known/oauth-protected-resource/mcp";
const ISSUER = "https://auth-staging.aisr.online";

function mock(options = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, url, headers: new Headers(init.headers) });
    if (url === ISSUER + "/.well-known/oauth-authorization-server") return Response.json({
      issuer: ISSUER, authorization_endpoint: ISSUER + "/oauth/authorize",
      token_endpoint: ISSUER + "/oauth/token", code_challenge_methods_supported: ["S256"],
    });
    if (url === META) return Response.json({
      resource: options.wrongResource ? "https://wrong-staging.aisr.online/mcp" : URI,
      authorization_servers: [ISSUER], bearer_methods_supported: ["header"],
      scopes_supported: ["resources:read"],
    });
    if (url === URI && init.method === "POST") {
      if (new Headers(init.headers).has("authorization")) {
        return Response.json({ error: "invalid_token" }, { status: options.acceptForged ? 200 : 401 });
      }
      return Response.json({ error: "OAuth authorization required" }, {
        status: options.badChallenge ? 302 : 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="' + META + '", scope="resources:read"' },
      });
    }
    throw new Error("Unexpected endpoint: " + url);
  };
  return { calls, fetcher };
}

test("only isolated, exact, explicit Staging single-resource URI may be probed", () => {
  assert.equal(stagingMcpResource(URI).href, URI);
  for (const invalid of [
    "", undefined, "https://example-mcp.aisr.online/mcp",
    "https://core.aisr.online/mcp", "https://core-staging.aisr.online/mcp/mcp_fixture",
    "http://example-mcp-staging.aisr.online/mcp",
    URI + "?token=not-permitted", URI + "#fragment",
    "https://evil.test/mcp", "https://user@example-mcp-staging.aisr.online/mcp",
    "https://example-mcp-staging.aisr.online/other",
  ]) {
    assert.throws(() => stagingMcpResource(invalid), /Staging|URI|exact|isolated/u, String(invalid));
  }
});

test("read-only staging probe checks exact Identity, Protected Resource metadata and Bearer boundary", async () => {
  const { fetcher, calls } = mock();
  const result = await verifyStagingMcpOAuthWire({ resourceUri: URI, fetcher });
  assert.equal(result.ok, true);
  assert.equal(result.noMutations, true);
  assert.equal(result.endToEndOAuthVerified, false);
  assert.equal(result.coreDataExecutionVerified, false);
  assert.equal(result.serverIdRoutingVerified, false);
  assert.deepEqual(calls.map(x => x.method), ["GET", "GET", "POST", "POST"]);
  assert.equal(calls[3].headers.get("authorization")?.startsWith("Bearer lsp_oat_"), true);
  assert.equal(calls.every(x => !x.headers.has("cookie")), true);
});

test("mismatching OAuth Resource metadata or missing Bearer challenge fails closed", async () => {
  for (const options of [{ wrongResource: true }, { badChallenge: true }, { acceptForged: true }]) {
    const { fetcher } = mock(options);
    await assert.rejects(
      verifyStagingMcpOAuthWire({ resourceUri: URI, fetcher }),
      /Resource metadata|must challenge|synthetic unissued/u,
    );
  }
});

test("invalid target never causes a network request", async () => {
  let called = 0;
  await assert.rejects(verifyStagingMcpOAuthWire({
    resourceUri: "https://core.aisr.online/mcp",
    fetcher: async () => { called++; throw new Error("Not allowed"); },
  }));
  assert.equal(called, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { convergeStagingMcpResourceSecret } from "./converge-staging-mcp-resource-secret.mjs";

const accountId = "a".repeat(32);
const token = "synthetic-Cloudflare-token-" + "b".repeat(40);
const secret = "safeRandomSynthetic_" + "x".repeat(64);
function fixture({ present = true, errorOn = "", invalidBinding = false } = {}) {
  const requests = [];
  const request = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body ?? null });
    if (url.endsWith("/workers/scripts") && init.method === "GET") {
      return Response.json({ success: true, result: [
        { id: "lifespace-identity-staging" },
        ...(present ? [{ id: "lifespace-mcp-adapter-staging" }] : []),
      ] });
    }
    if (init.method === "PUT" && url.endsWith("/secrets")) {
      if (url.includes("api-success-false")) return Response.json({ success: false });
      if (url.includes(errorOn) && errorOn) return Response.json({ success: false }, { status: 400 });
      return Response.json({ success: true });
    }
    if (init.method === "GET" && url.endsWith("/secrets")) {
      return Response.json({ success: true, result: invalidBinding ? [] : [
        { name: "OAUTH_RESOURCE_SERVER_SECRET" },
      ] });
    }
    throw new Error("Unexpected API call " + url);
  };
  return { request, requests };
}
const opts = request => ({
  accountId, token, request, secretGenerator: () => secret,
});

test("paired secrets use the same value and touch staging Workers only", async () => {
  const f = fixture();
  const result = await convergeStagingMcpResourceSecret(opts(f.request));
  assert.equal(result.ok, true);
  assert.equal(result.plaintextExposed, false);
  assert.equal(result.productionTouched, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const writes = f.requests.filter(x => x.method === "PUT");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes.map(x => new URL(x.url).pathname.split("/").at(-2)), [
    "lifespace-identity-staging", "lifespace-mcp-adapter-staging",
  ]);
  assert.deepEqual(writes.map(x => JSON.parse(x.body)), [
    { name: "OAUTH_RESOURCE_SERVER_SECRET", type: "secret_text", text: secret },
    { name: "OAUTH_RESOURCE_SERVER_SECRET", type: "secret_text", text: secret },
  ]);
  assert.equal(f.requests.some(x => x.url.includes("/lifespace-core") || x.url.includes("/lifespace-identity/secrets")), false);
});
test("refuses HTTP 200 with Cloudflare success=false for a secret mutation", async () => {
  const f = fixture();
  const request = async (url, init) => {
    if (url.endsWith("/lifespace-identity-staging/secrets") && init.method === "PUT") {
      return Response.json({ success: false });
    }
    return f.request(url, init);
  };
  await assert.rejects(convergeStagingMcpResourceSecret(opts(request)), /convergence failed/);
  assert.equal(f.requests.some(x => x.url.includes("/lifespace-mcp-adapter-staging/secrets")), false);
});

test("never modifies either Worker unless both staging scripts exist", async () => {
  const f = fixture({ present: false });
  await assert.rejects(convergeStagingMcpResourceSecret(opts(f.request)), /Both exact/);
  assert.equal(f.requests.filter(x => x.method === "PUT").length, 0);
});
test("fails on unsafe inputs, partial failures or absent secret names", async () => {
  const f = fixture();
  await assert.rejects(convergeStagingMcpResourceSecret({
    ...opts(f.request), accountId: "fake-id",
  }), /Protected Cloudflare/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(convergeStagingMcpResourceSecret({
    ...opts(f.request), secretGenerator: () => "unsafe",
  }), /Unsafe random/);
  assert.equal(f.requests.filter(x => x.method === "PUT").length, 0);
  const partial = fixture({ errorOn: "lifespace-mcp-adapter-staging" });
  await assert.rejects(convergeStagingMcpResourceSecret(opts(partial.request)), /convergence failed/);
  const absent = fixture({ invalidBinding: true });
  await assert.rejects(convergeStagingMcpResourceSecret(opts(absent.request)), /binding missing/);
});

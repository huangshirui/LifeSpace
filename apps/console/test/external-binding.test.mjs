import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../worker/external-configuration.ts", import.meta.url), "utf8")
  .replace('import agentGovernanceWorker from "./agent-governance";', 'const agentGovernanceWorker = { fetch: () => new Response("delegated", { status: 299 }) };');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const worker = (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)).default;

function fixture() {
  const calls = [];
  const env = {
    ENVIRONMENT: "local",
    IDENTITY_BASE_URL: "https://identity.example.com",
    CORE_BASE_URL: "https://core.example.com",
    IDENTITY_APPLICATION_CREDENTIAL: "synthetic-server-only",
    ASSETS: { fetch: () => new Response() },
    IDENTITY: {
      async fetch(request) {
        calls.push(request);
        return Response.json({ data: { accessToken: "synthetic-user-bearer" } });
      },
    },
    CORE: {
      async fetch(request) {
        calls.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/resources")) return Response.json({ data: { items: [{ id: "resource-1", type: "data_source", displayName: "Health Documents" }], nextCursor: null } });
        if (path.endsWith("/external-connections") && request.method === "POST") return Response.json({ data: { id: "exc_" + "a".repeat(32), providerKey: "notion", displayName: "Personal Notion", access: "write", status: "active", credentialMode: "managed" } }, { status: 201 });
        return Response.json({ data: { items: [] } });
      },
    },
  };
  return { calls, env };
}

const bindingUrl = "https://console.example.com/api/spaces/spc_synthetic/external-models";
const bindingBody = { definitionKey: "external_document", connectionId: "exc_" + "a".repeat(32), resourceId: "synthetic_source", declaredAccess: "read" };
function mutation(url, intent, body, headers = {}, method = "POST") {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      "cf-access-jwt-assertion": "synthetic.access.assertion",
      origin: "https://console.example.com",
      "sec-fetch-site": "same-origin",
      "x-lifespace-console-intent": intent,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("binding rejects CSRF and missing intent before exchanging credentials", async () => {
  for (const headers of [{ origin: "https://other.example.com" }, { "sec-fetch-site": "cross-site" }, { "x-lifespace-console-intent": "" }]) {
    const f = fixture();
    assert.equal((await worker.fetch(mutation(bindingUrl, "bind-external-model", bindingBody, headers), f.env)).status, 403);
    assert.equal(f.calls.length, 0);
  }
});

test("binding uses verified User Space authority and keeps LifeSpace executors server-side", async () => {
  const f = fixture();
  const response = await worker.fetch(mutation(bindingUrl, "bind-external-model", bindingBody), f.env);
  assert.equal(response.status, 200);
  const identity = f.calls.find((request) => new URL(request.url).pathname === "/internal/v1/access/tokens");
  assert.deepEqual((await identity.json()).requestedScopes, ["profile:read", "spaces:manage"]);
  const core = f.calls.find((request) => new URL(request.url).host === "core.example.com");
  assert.equal(core.headers.get("authorization"), "Bearer synthetic-user-bearer");
  assert.equal(core.headers.has("x-lifespace-actor-token"), false);
  assert.deepEqual(await core.json(), bindingBody);
  const wire = await response.text();
  assert.equal(wire.includes("synthetic-user-bearer"), false);
  assert.equal(wire.includes("synthetic-server-only"), false);
});

test("connection setup accepts provider credential only on the bounded same-origin mutation and never echoes it", async () => {
  const f = fixture();
  const providerToken = "provider-token-visible-only-to-core-request";
  const body = { providerKey: "notion", displayName: "Personal Notion", credential: { type: "bearer_token", token: providerToken }, access: "write" };
  const response = await worker.fetch(mutation("https://console.example.com/api/spaces/spc_synthetic/external-connections", "create-external-connection", body), f.env);
  assert.equal(response.status, 201);
  const core = f.calls.find((request) => new URL(request.url).host === "core.example.com");
  assert.deepEqual(await core.json(), body);
  assert.equal((await response.text()).includes(providerToken), false);
});

test("resource discovery is bounded and forwards only the selected Space connection", async () => {
  const f = fixture();
  const request = new Request(`https://console.example.com/api/spaces/spc_synthetic/external-connections/exc_${"a".repeat(32)}/resources?query=Health&limit=20`, {
    headers: { "cf-access-jwt-assertion": "synthetic.access.assertion" },
  });
  const response = await worker.fetch(request, f.env);
  assert.equal(response.status, 200);
  const core = f.calls.find((item) => new URL(item.url).host === "core.example.com");
  assert.equal(new URL(core.url).search, "?query=Health&limit=20");
  assert.equal(JSON.stringify(await response.json()).includes("Health Documents"), true);

  const duplicate = new Request(`https://console.example.com/api/spaces/spc_synthetic/external-connections/exc_${"a".repeat(32)}/resources?limit=20&limit=30`, {
    headers: { "cf-access-jwt-assertion": "synthetic.access.assertion" },
  });
  const g = fixture();
  assert.equal((await worker.fetch(duplicate, g.env)).status, 422);
  assert.equal(g.calls.length, 0);
});

test("unlinked Access identity and Core denial cannot acquire hidden Space membership", async () => {
  const f = fixture();
  f.env.CORE.fetch = async (request) => { f.calls.push(request); return Response.json({ error: { code: "ACCESS_DENIED", message: "Denied" } }, { status: 403 }); };
  assert.equal((await worker.fetch(mutation(bindingUrl, "bind-external-model", bindingBody), f.env)).status, 403);

  const g = fixture();
  g.env.IDENTITY.fetch = async () => Response.json({ error: { code: "ACCESS_PRINCIPAL_UNLINKED", message: "Unlinked" } }, { status: 409 });
  assert.equal((await worker.fetch(mutation(bindingUrl, "bind-external-model", bindingBody), g.env)).status, 409);
  assert.equal(g.calls.length, 0);
});

test("non-External routes remain delegated to the established Console chain", async () => {
  const f = fixture();
  const response = await worker.fetch(new Request("https://console.example.com/api/models"), f.env);
  assert.equal(response.status, 299);
  assert.equal(await response.text(), "delegated");
});

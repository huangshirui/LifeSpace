import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
const source = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const worker = (await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`)).default;
function fixture() {
 const calls = [];
 const env = { ENVIRONMENT: "local", IDENTITY_BASE_URL: "https://identity.example.com", CORE_BASE_URL: "https://core.example.com", IDENTITY_APPLICATION_CREDENTIAL: "synthetic-server-only", CORE_EXECUTOR_BEARER: "synthetic-platform-executor", ASSETS: { fetch: () => new Response() },
  IDENTITY: { async fetch(request) { calls.push(request); if (new URL(request.url).pathname === "/api/v1/me") return Response.json({ data: { id: "usr_synthetic", displayName: "Synthetic", status: "active" } }); return Response.json({ data: { accessToken: "synthetic-user-bearer" } }); } },
  CORE: { async fetch(request) { calls.push(request); return Response.json({ data: { items: [{ id: "exs_synthetic", providerKey: "synthetic", status: "active" }] } }); } } };
 return { calls, env };
}
const url = "https://console.example.com/api/spaces/spc_synthetic/external-models";
const body = { definitionKey: "external_document", sourceId: "exs_" + "a".repeat(32), resourceId: "synthetic_source", declaredAccess: "read" };
function request(headers = {}) { return new Request(url, { method: "POST", headers: { "content-type": "application/json", "cf-access-jwt-assertion": "synthetic.access.assertion", origin: "https://console.example.com", "sec-fetch-site": "same-origin", "x-lifespace-console-intent": "bind-external-model", ...headers }, body: JSON.stringify(body) }); }
test("binding rejects CSRF and missing intent before exchanging credentials", async () => {
 for (const headers of [{ origin: "https://other.example.com" }, { "sec-fetch-site": "cross-site" }, { "x-lifespace-console-intent": "" }]) { const f = fixture(); assert.equal((await worker.fetch(request(headers), f.env)).status, 403); assert.equal(f.calls.length, 0); }
});
test("binding uses verified User Space authority and keeps every token server-side", async () => {
 const f = fixture(); const response = await worker.fetch(request(), f.env); assert.equal(response.status, 200);
 const identity = f.calls.find(r => new URL(r.url).pathname === "/internal/v1/access/tokens"); assert.deepEqual((await identity.json()).requestedScopes, ["profile:read", "spaces:manage"]);
 const core = f.calls.find(r => new URL(r.url).host === "core.example.com"); assert.equal(core.headers.get("authorization"), "Bearer synthetic-user-bearer"); assert.equal(core.headers.has("x-lifespace-actor-token"), false); assert.deepEqual(await core.json(), body);
 const wire = await response.text(); assert.equal(wire.includes("synthetic-user-bearer"), false); assert.equal(wire.includes("synthetic-platform-executor"), false);
});
test("unlinked Access identity and Core denial cannot acquire hidden Space membership", async () => {
 const f = fixture(); f.env.CORE.fetch = async request => { f.calls.push(request); return Response.json({ error: { code: "ACCESS_DENIED", message: "Denied" } }, { status: 403 }); };
 assert.equal((await worker.fetch(request(), f.env)).status, 403);
 const g = fixture(); g.env.IDENTITY.fetch = async () => Response.json({ error: { code: "ACCESS_PRINCIPAL_UNLINKED", message: "Unlinked" } }, { status: 409 }); assert.equal((await worker.fetch(request(), g.env)).status, 409); assert.equal(g.calls.length, 0);
});

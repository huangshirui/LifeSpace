import assert from "node:assert/strict";
import test from "node:test";
import { onboardApplication, validateOnboardingInput } from "../src/onboarding.mjs";

function response(status, body) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function env({ coreStatus = 200 } = {}) {
  const calls = [];
  const identity = {
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" || request.method === "DELETE" ? null : await request.json();
      calls.push({ service: "identity", method: request.method, path: url.pathname, body });
      if (request.method === "POST" && url.pathname === "/bootstrap/v1/applications") {
        return response(201, { data: { id: body.id, clientSecret: "lsa_once_only_secret" } });
      }
      if (request.method === "PATCH" && url.pathname.startsWith("/bootstrap/v1/applications/")) return response(200, { data: { status: "disabled" } });
      if (request.method === "GET" && url.pathname.endsWith("/credentials")) {
        return response(200, { data: [{ id: "apc_test", status: "active" }] });
      }
      if (request.method === "DELETE" && url.pathname.endsWith("/credentials/apc_test")) return response(204, null);
      return response(404, { error: { code: "NOT_FOUND" } });
    },
  };
  const core = {
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "GET" ? null : await request.json();
      calls.push({ service: "core", method: request.method, path: url.pathname, body });
      if (request.method === "PUT" && url.pathname.includes("/model-admin/applications/")) {
        return coreStatus === 200
          ? response(200, { data: { applicationId: url.pathname.split("/").at(-2), models: body.models } })
          : response(coreStatus, { error: { code: "UPSTREAM_FAILURE" } });
      }
      return response(404, { error: { code: "NOT_FOUND" } });
    },
  };
  return {
    env: {
      IDENTITY: identity,
      CORE: core,
      IDENTITY_BOOTSTRAP_SECRET: "bootstrap-secret-at-least-32-chars",
      CORE_ADMIN_TOKEN: "lsp_pat_admin",
      PUBLIC_CORE_URL: "https://core-staging.aisr.online",
      PUBLIC_IDENTITY_URL: "https://auth-staging.aisr.online",
    },
    calls,
  };
}

const input = {
  name: "Goal Tracker",
  clientType: "mini_program",
  trustedBackend: true,
  allowedScopes: ["resources:read", "resources:write"],
  accessTokenTtlSeconds: 900,
  modelAccess: [{ modelKey: "task", maxAccess: "write" }],
};

test("validates application onboarding input", () => {
  assert.deepEqual(validateOnboardingInput(input), input);
  assert.throws(() => validateOnboardingInput({ ...input, modelAccess: [{ modelKey: "task", maxAccess: "root" }] }), /maxAccess/u);
  assert.throws(() => validateOnboardingInput({ ...input, allowedScopes: ["resources:read", "resources:read"] }), /duplicates/u);
});

test("creates Identity application then configures Core model access", async () => {
  const fixture = env();
  const result = await onboardApplication(fixture.env, input, { email: "admin@example.com" });
  assert.match(result.applicationId, /^app_[a-f0-9]{32}$/u);
  assert.equal(result.clientSecret, "lsa_once_only_secret");
  assert.equal(result.operatorEmail, "admin@example.com");
  assert.deepEqual(result.modelAccess, input.modelAccess);
  assert.deepEqual(fixture.calls.slice(0, 2).map((call) => [call.service, call.method]), [["identity", "POST"], ["core", "PUT"]]);
  assert.equal(fixture.calls[0].body.id, result.applicationId);
  assert.equal(fixture.calls[1].body.models[0].modelKey, "task");
});

test("disables Identity application and revokes its credential when Core configuration fails", async () => {
  const fixture = env({ coreStatus: 422 });
  await assert.rejects(
    () => onboardApplication(fixture.env, input, { email: "admin@example.com" }),
    (error) => error.code === "CORE_APPLICATION_ACCESS_FAILED" && error.status === 502,
  );
  assert.ok(fixture.calls.some((call) => call.service === "identity" && call.method === "PATCH" && call.body.status === "disabled"));
  assert.ok(fixture.calls.some((call) => call.service === "identity" && call.method === "DELETE" && call.path.endsWith("/credentials/apc_test")));
});

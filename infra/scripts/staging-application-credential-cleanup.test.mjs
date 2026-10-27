import test from "node:test";
import assert from "node:assert/strict";

const script = new URL("./verify-staging-application-admin.mjs", import.meta.url);
const keys = [
  "LIFESPACE_IDENTITY_STAGING_URL",
  "LIFESPACE_STAGING_BOOTSTRAP_SECRET",
  "LIFESPACE_STAGING_SMOKE_APPLICATION_ID",
  "LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET",
  "LIFESPACE_STAGING_SMOKE_USER_ID",
];

const reply = (status, data) => ({
  status,
  text: async () => data === undefined ? "" : JSON.stringify({ data }),
});

async function runScenario(mode) {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const fetchBefore = globalThis.fetch;
  const logBefore = console.log;
  let revoked = false;
  let revokeCalls = 0;
  let created = 0;
  try {
    Object.assign(process.env, {
      LIFESPACE_IDENTITY_STAGING_URL: "https://auth-staging.example.test",
      LIFESPACE_STAGING_BOOTSTRAP_SECRET: "a".repeat(40),
      LIFESPACE_STAGING_SMOKE_APPLICATION_ID: "app_mock",
      LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: "lsa_original",
      LIFESPACE_STAGING_SMOKE_USER_ID: "usr_mock",
    });
    console.log = () => {};
    globalThis.fetch = async (target, opts = {}) => {
      const path = new URL(target).pathname;
      const method = opts.method ?? "GET";
      if (path === "/internal/v1/applications/self") {
        assert.equal(opts.headers.authorization, "Bearer lsa_original");
        return reply(200, { id: "app_mock", allowedScopes: ["resources:read"], status: "active", trustedBackend: true });
      }
      if (path.endsWith("/credentials") && method === "GET") return reply(200, []);
      if (path.endsWith("/credentials") && method === "POST") {
        created++;
        return reply(201, { id: "apc_temporary", clientSecret: "lsa_temporary", ...(mode === "hash" ? { secretHash: "invalid" } : {}) });
      }
      if (path.endsWith("/credentials/apc_temporary") && method === "DELETE") {
        revokeCalls++;
        if (mode === "revoke-once-fails" && revokeCalls === 1) return reply(503);
        revoked = true;
        return reply(204);
      }
      if (path === "/internal/v1/tokens" && method === "POST") {
        const bearer = opts.headers.authorization;
        if (bearer === "Bearer lsa_original") return reply(200, { accessToken: "original-jwt" });
        if (bearer === "Bearer lsa_temporary") return revoked ? reply(401) : mode === "exchange" ? reply(503) : reply(200, { accessToken: "temporary-jwt" });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    };
    let failure = null;
    try {
      await import(`${script.href}?scenario=${mode}`);
    } catch (e) {
      failure = e;
    }
    return { failure, revoked, revokeCalls, created };
  } finally {
    globalThis.fetch = fetchBefore;
    console.log = logBefore;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("normal staging credential verification revokes its replacement exactly once", async () => {
  const result = await runScenario("success");
  assert.equal(result.failure, null);
  assert.equal(result.created, 1);
  assert.equal(result.revokeCalls, 1);
  assert.equal(result.revoked, true);
});

test("failed exchange cannot skip replacement credential cleanup", async () => {
  const result = await runScenario("exchange");
  assert.match(String(result.failure), /could not exchange a user token/u);
  assert.equal(result.revokeCalls, 1);
  assert.equal(result.revoked, true);
});

test("unexpected leaked hash in create response cannot skip cleanup", async () => {
  const result = await runScenario("hash");
  assert.match(String(result.failure), /leaked a hash/u);
  assert.equal(result.revokeCalls, 1);
  assert.equal(result.revoked, true);
});

test("failed revoke is retried in finally and retains the original failure", async () => {
  const result = await runScenario("revoke-once-fails");
  assert.match(String(result.failure), /credential revoke failed/u);
  assert.equal(result.revokeCalls, 2);
  assert.equal(result.revoked, true);
});

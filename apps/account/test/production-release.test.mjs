import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { requireProductionAccountAccess } from "../scripts/prepare-production-access.mjs";
import { requireProductionAccountApplication } from "../scripts/prepare-production-identity.mjs";
import { assertProductionWorkerBindings } from "../scripts/verify-production-bindings.mjs";
import { assertFirstUseProductionBindings } from "../scripts/check-production-first-use.mjs";
import { matchesProductionRelease } from "../scripts/check-platform-production-convergence.mjs";
import { checkMigrationVersion } from "../../../infra/scripts/verify-production-d1-time-travel.mjs";

const workflow = name => readFileSync(
  new URL("../../../.github/workflows/" + name, import.meta.url), "utf8",
);

const ownerOnly = [
  { name: "Owner only", decision: "allow", precedence: 1,
    include: [{ email: { email: "owner@example.test" } }] },
];
const anotherUser = [
  { name: "Anyone", decision: "allow", precedence: 1,
    include: [{ email: { email: "intruder@example.test" } }] },
];
const accountAccess = {
  type: "self_hosted", name: "LifeSpace Account",
  domain: "account.aisr.online", aud: "A".repeat(35),
};
const app = {
  id: "app_lifespace_account", name: "LifeSpace Account production",
  status: "active", trustedBackend: true, accessTokenTtlSeconds: 900,
  allowedScopes: ["profile:read", "profile:write", "spaces:read", "spaces:write", "spaces:manage"],
};

test("Production Account Access cannot broaden owner policy or protect the wrong host", () => {
  assert.equal(requireProductionAccountAccess(accountAccess, ownerOnly, ownerOnly), accountAccess.aud);
  assert.throws(() => requireProductionAccountAccess(accountAccess, anotherUser, ownerOnly), /differs/u);
  assert.throws(() => requireProductionAccountAccess(
    { ...accountAccess, domain: "account-staging.aisr.online" }, ownerOnly, ownerOnly), /isolated/u);
  assert.throws(() => requireProductionAccountAccess(
    { ...accountAccess, type: "saas" }, ownerOnly, ownerOnly), /isolated/u);
});

test("Production Account Application refuses implicit scope enlargement", () => {
  assert.equal(requireProductionAccountApplication(app).id, app.id);
  assert.throws(() => requireProductionAccountApplication({ ...app,
    allowedScopes: [...app.allowedScopes, "platform:admin"] }), /authority/u);
  assert.throws(() => requireProductionAccountApplication({ ...app,
    id: "app_lifespace_account_staging" }), /authority/u);
});

const service = (name, target) => ({ type: "service", name, service: target });
const secret = name => ({ type: "secret_text", name });
const core = [service("IDENTITY", "lifespace-identity"),
  service("MCP_ADAPTER", "lifespace-mcp-adapter")];
const identity = [service("CORE", "lifespace-core")];
const adapter = [service("CORE", "lifespace-core"),
  service("IDENTITY", "lifespace-identity"),
  secret("OAUTH_RESOURCE_SERVER_SECRET")];

test("first-use guard rejects partial setup, missing private Adapter or wrong environment", () => {
  assert.equal(assertFirstUseProductionBindings(core, identity, adapter, false).ok, true);
  assert.throws(() => assertFirstUseProductionBindings(core, identity, adapter, true), /already exists/u);
  assert.throws(() => assertFirstUseProductionBindings(core, identity,
    adapter.filter(x => x.name !== "OAUTH_RESOURCE_SERVER_SECRET"), false), /Secret/u);
  assert.throws(() => assertFirstUseProductionBindings(
    [service("MCP_ADAPTER", "lifespace-mcp-adapter-staging"), core[0]],
    identity, adapter, false), /same-environment/u);
  assert.throws(() => assertFirstUseProductionBindings(
    [...core, secret("OAUTH_CORE_APPROVER_SECRET")], identity, adapter, false), /already has OAuth/u);
});

test("Production Worker gate enforces independent Account bindings and zero persistence", () => {
  const accountBindings = [
    service("CORE", "lifespace-core"), service("IDENTITY", "lifespace-identity"),
    secret("IDENTITY_APPLICATION_CREDENTIAL"), secret("ACCOUNT_CSRF_SECRET"),
  ];
  assert.equal(assertProductionWorkerBindings("lifespace-account", accountBindings).checkedSecretNames, 2);
  assert.throws(() => assertProductionWorkerBindings("lifespace-account", [
    ...accountBindings, { type: "d1", name: "DB" },
  ]), /persistence/u);
  assert.throws(() => assertProductionWorkerBindings("lifespace-account", [
    ...accountBindings.filter(x => x.name !== "CORE"), service("CORE", "lifespace-core-staging"),
  ]), /Cross-environment/u);
  assert.throws(() => assertProductionWorkerBindings("lifespace-account",
    accountBindings.filter(x => x.name !== "ACCOUNT_CSRF_SECRET")), /Missing protected/u);
});

test("D1 Time Travel preflight denies downgrade and missing schema versions", () => {
  assert.equal(checkMigrationVersion({ current: 76, expected: 78, label: "core" }).pending, 2);
  assert.throws(() => checkMigrationVersion({ current: 79, expected: 78, label: "core" }), /newer/u);
  assert.throws(() => checkMigrationVersion({ current: 0, expected: 18, label: "identity" }), /unavailable/u);
  assert.equal(matchesProductionRelease(
    { environment: "production", schemaVersion: 18, contractVersion: "1.0" },
    { schemaVersion: 18, contractVersion: "1.0" }), true);
});

test("First-use production workflow is owner-only, guarded, and never scheduled", () => {
  const s = workflow("lifespace-account-production-provision.yml");
  for (const phrase of ['test "$GITHUB_ACTOR" = huangshirui',
    'test "$GITHUB_TRIGGERING_ACTOR" = huangshirui',
    'test "$GITHUB_REF_NAME" = main',
    'INITIALIZE_ACCOUNT_PRODUCTION_ONCE',
    "verify-release-candidate.mjs production",
    "check-production-first-use.mjs",
    "prepare-production-access.mjs",
    "prepare-production-identity.mjs",
    "verify-production-bindings.mjs"]) assert.ok(s.includes(phrase), phrase);
  assert.ok(s.indexOf("prepare-production-access.mjs")
    < s.indexOf("wrangler deploy --env production"));
  assert.ok(s.indexOf("check-production-first-use.mjs")
    < s.indexOf("prepare-production-identity.mjs"));
  assert.ok(!/^\s+(?:schedule|push|pull_request):/mu.test(s));
  assert.ok(!s.includes("db:migrate:"));
});

test("Routine Production Account deploy cannot rotate secrets or change Core", () => {
  const s = workflow("lifespace-account-production-deploy.yml");
  assert.ok(s.includes("verify-release-candidate.mjs production account"));
  assert.ok(s.includes('test "$GITHUB_ACTOR" = huangshirui'));
  assert.ok(s.includes("verify-production-access.mjs"));
  assert.ok(s.includes("verify-production-bindings.mjs"));
  assert.ok(s.includes("pnpm --dir apps/account exec wrangler deploy --env production"));
  for (const forbidden of ["wrangler secret put", "db:migrate:", "prepare-production-access.mjs",
    "prepare-production-identity.mjs", "pnpm --dir apps/core exec wrangler",
    "pnpm --dir apps/identity exec wrangler"]) {
    assert.ok(!s.includes(forbidden), forbidden);
  }
});

test("Canonical Production Platform workflow checks Time Travel before migration", () => {
  const s = workflow("production-deploy.yml");
  assert.ok(s.indexOf("verify-production-d1-time-travel.mjs") > 0);
  assert.ok(s.indexOf("verify-production-d1-time-travel.mjs")
    < s.indexOf("Apply Core migrations"));
  assert.ok(s.indexOf("verify-production-d1-time-travel.mjs")
    < s.indexOf("Apply Identity migrations"));
});

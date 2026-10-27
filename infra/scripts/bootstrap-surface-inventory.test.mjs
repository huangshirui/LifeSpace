import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  checkBootstrapSurface,
  inspectBootstrapSurface,
  LEGACY_REFERENCE_BUDGET,
  LEGACY_ROUTE_BUDGET,
} from "./bootstrap-surface-inventory.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("current legacy Bootstrap source inventory is within its shrinking ceiling", () => {
  const report = checkBootstrapSurface(root);
  assert.ok(report.routes.length > 0, "Migration has not yet retired all Bootstrap routes");
  assert.ok(report.totalReferences > 0);
  assert.ok(report.files.some((file) => file.category === "initial-seed"));
  for (const entry of report.files) {
    assert.ok(entry.count <= LEGACY_REFERENCE_BUDGET[entry.path].max);
  }
});

test("new Bootstrap consumers fail even when they are under a known directory", () => {
  assert.throws(() => inspectBootstrapSurface([{
    path: "apps/console/worker/normal-runtime.ts",
    source: 'fetch("/bootstrap/v1/applications")',
  }]), /Unapproved Bootstrap consumer/u);
});

test("current allowlisted Bootstrap consumer cannot increase its reference count", () => {
  assert.throws(() => inspectBootstrapSurface([{
    path: "infra/scripts/prepare-staging-smoke.mjs",
    source: 'fetch("/bootstrap/v1/applications"); fetch("/bootstrap/v1/applications")',
  }]), /Bootstrap reference budget exceeded/u);
});

test("new Bootstrap routes are denied even within a known router file", () => {
  assert.throws(() => inspectBootstrapSurface([{
    path: "apps/identity/src/app.ts",
    source: 'app.get("/bootstrap/v1/new-master-credential", handler)',
  }]), /Unapproved Bootstrap API route/u);
});

test("already-declared routes are allowed, no new routes needed for regular administration", () => {
  const report = inspectBootstrapSurface([{
    path: "apps/identity/src/app.ts",
    source: 'app.post("/bootstrap/v1/applications", handler)',
  }]);
  assert.equal(report.routes.length, 1);
  assert.ok(LEGACY_ROUTE_BUDGET.includes(report.routes[0]));
});

test("removing a former Bootstrap call is allowed without updating the budget first", () => {
  const report = inspectBootstrapSurface([{
    path: "infra/scripts/prepare-staging-smoke.mjs",
    source: 'fetch("/api/v1/status")',
  }]);
  assert.deepEqual(report.files, []);
  assert.equal(report.totalReferences, 0);
});

test("duplicate Bootstrap server registrations are denied", () => {
  assert.throws(() => inspectBootstrapSurface([{
    path: "apps/identity/src/platform-admin-assignment.ts",
    source: 'app.get("/bootstrap/v1/platform-administrators", a); app.get("/bootstrap/v1/platform-administrators", b)',
  }]), /Duplicate Bootstrap API route/u);
});

test("Staging Eventing acceptance reads its own Application and never escalates through Bootstrap", () => {
  const smoke = readFileSync(resolve(root, "infra/scripts/prepare-staging-smoke.mjs"), "utf8");
  for (const scope of ["spaces:manage", "grants:manage", "resources:read", "resources:write"]) {
    assert.ok(smoke.includes(`"${scope}"`), `Smoke initializer missing ${scope}`);
  }
  for (const path of [
    "infra/scripts/verify-staging-eventing.mjs",
    "infra/scripts/verify-staging-eventing-principal-revocation.mjs",
  ]) {
    assert.equal(LEGACY_REFERENCE_BUDGET[path], undefined, `${path} must remain retired from Bootstrap allowlist`);
    const source = readFileSync(resolve(root, path), "utf8");
    assert.ok(source.includes('"/internal/v1/applications/self"'), `Own identity inspection missing in ${path}`);
    assert.ok(source.includes("bearer: applicationSecret"), `Own credential binding missing in ${path}`);
    assert.ok(source.includes('appData?.id !== applicationId'), `Application identity verification missing in ${path}`);
    assert.ok(source.includes('requiredScopes.some((scope) => !appData.allowedScopes.includes(scope))'), `Scope fail-closed enforcement missing in ${path}`);
    assert.ok(!source.includes("/bootstrap/v1/"), `Bootstrap route leaked into ${path}`);
    assert.ok(!source.includes("LIFESPACE_STAGING_BOOTSTRAP_SECRET"), `Bootstrap secret leaked into ${path}`);
    assert.ok(!source.includes("applicationScopesChanged"), `Temporary scope elevation leaked into ${path}`);
  }
});

test("Staging Console acceptance uses its current temporary lsa_* credential for metadata and never returns to Bootstrap GET", () => {
  const scenarios = [
    { path: "apps/console/scripts/verify-staging-control-plane.mjs", appId: "applicationId", secret: "cleanup.applicationCredential", label: "applicationCredentialId" },
    { path: "apps/console/scripts/verify-staging-space-governance.mjs", appId: "applicationId", secret: "cleanup.applicationCredential", label: "applicationCredentialId" },
    { path: "apps/console/scripts/verify-staging-configuration-center.mjs", appId: "consoleApplicationId", secret: "cleanup.consoleCredential", label: "consoleCredentialId" },
  ];
  for (const { path, appId, secret, label } of scenarios) {
    const source = readFileSync(resolve(root, path), "utf8");
    assert.equal(LEGACY_REFERENCE_BUDGET[path].max, 3, `${path} must retain the reduced Bootstrap reference ceiling`);
    const applicationPath = "/bootstrap/v1/applications/" + "${encodeURIComponent(" + appId + ")}";
    assert.ok(!source.includes(applicationPath + "`"), `Direct Bootstrap metadata read remains: ${path}`);
    const credentialCreated = source.indexOf(applicationPath + "/credentials");
    const metadataInspected = source.indexOf('"/internal/v1/applications/self"');
    assert.ok(credentialCreated >= 0 && metadataInspected > credentialCreated, `Own metadata inspection must follow temporary credential creation: ${path}`);
    assert.ok(source.includes(`bearer: ${secret}`), `Self-inspection must bind current Application credential: ${path}`);
    assert.ok(source.includes(`?.id !== ${appId}`), `Staging Console must reject another Application ID: ${path}`);
    assert.ok(source.includes("allowedScopes") && source.includes("missingScopes"), `Required scopes must be re-checked on current identity: ${path}`);
    assert.ok(source.includes(`cleanup.${label} =`), `Temporary credential must be tracked for cleanup: ${path}`);
    assert.ok(source.includes("finally {"), `Temporary credential must be cleaned up even on inspection failure: ${path}`);
  }
});

test("Agent-ready Staging registers successfully provisioned credentials before the next Application", () => {
  const source = readFileSync(resolve(root, "infra/scripts/verify-staging-agent-ready.mjs"), "utf8");
  assert.ok(!source.includes("Promise.all(agents.map(ensureApplication))"), "Parallel provisioning risks losing successfully issued credential IDs on rejection");
  assert.ok(source.includes('const context = { ...agent, credential: "", credentialId: "" };\n    contexts.push(context);\n    await ensureApplication(context);'), "Every Application must enter the cleanup registry before remote creation starts");
  assert.ok(source.includes('spec.credential = data?.clientSecret ?? "";'), "Record issued client secret before any post-create validation");
  assert.ok(source.includes("spec.credentialId = data?.id ?? \"\";"), "Record a returned credential ID before validating it");
  assert.ok(source.includes("current.length !== 1"), "Never revoke a credential inferred from an ambiguous suffix");
  assert.ok(source.includes("async function revokeCredential(context)"), "Partial contexts must be cleaned in finally");
  assert.ok(source.includes("for (const context of contexts) await cleanup"), "Registered credentials must be revoked from finally");
});

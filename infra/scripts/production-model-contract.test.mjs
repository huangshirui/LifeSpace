import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptedHomeMewModelSemantics,
  assertHomeMewModelSemanticCompatibility,
} from "./homemew-contract-identity.mjs";
import { PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";
import { PROVING_MODELS as STAGING_PROVING_MODELS } from "./staging-expectations.mjs";

const modelAdminVerifier = new URL("./verify-production-model-admin.mjs", import.meta.url);
const homemewReleaseVerifier = new URL("./verify-production-homemew-contract.mjs", import.meta.url);
const releaseReadiness = new URL("./check-production-release-readiness.mjs", import.meta.url);
const productionWorkflow = new URL("../../.github/workflows/production-deploy.yml", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));

test("production proving models reuse the same shipped semantic identity as staging", () => {
  assert.equal(PRODUCTION_PROVING_MODELS, STAGING_PROVING_MODELS, "staging and production must share one proving-model release truth");
  const event = PRODUCTION_PROVING_MODELS.find((model) => model.key === "event");
  assert.ok(event, "Event must remain a production proving model");
  assert.equal(event.minimumVersion, 6, "Event v6 is the production Registry floor");
  assert.equal(
    event.hash,
    "be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a",
    "production proving semantics must pin the Event v6 schema hash",
  );

  const wish = PRODUCTION_PROVING_MODELS.find((model) => model.key === "wish");
  assert.ok(wish, "Wish must remain a production proving model");
  assert.equal(wish.minimumVersion, 7, "Wish modelKey-addressed release version remains the production Registry floor");
  assert.equal(
    wish.hash,
    "7dc6c079916a967c8bcd93f8cbe082c98157ceaeb30ce782ef3f2eb035d370df",
    "production proving semantics must pin the modelKey-addressed Wish schema hash",
  );
  assert.equal("version" in wish, false, "production must not assume one exact environment-local Wish Registry version");
});

test("production release readiness blocks mutation until accepted application semantics are promoted", () => {
  const source = readFileSync(fileURLToPath(releaseReadiness), "utf8");
  assert.match(source, /profile\.contracts\?\.coreKernel !== PRODUCTION_EXPECTATIONS\.core\.contractVersion/u, "release readiness must compare the accepted HomeMew Kernel pin to the production release");
  assert.match(source, /profile\.contracts\?\.identity !== PRODUCTION_EXPECTATIONS\.identity\.contractVersion/u, "release readiness must compare the accepted Identity pin to the production release");
  assert.match(source, /profile\.contracts\?\.integrationEventing !== integrationEventingContract\.info\?\.version/u, "post-split release readiness must compare the accepted Integration\/Eventing pin to the production release");
  assert.match(source, /assertHomeMewModelSemanticCompatibility/u, "release readiness must compare accepted model semantics to production proving semantics");
  assert.doesNotMatch(source, /route:\s*model\.route/u, "new production semantic identity must not revive route identity");

  const workflow = readFileSync(fileURLToPath(productionWorkflow), "utf8");
  const readinessIndex = workflow.indexOf("node infra/scripts/check-production-release-readiness.mjs");
  const migrationIndex = workflow.indexOf("pnpm --filter @lifespace/core db:migrate:production");
  assert.notEqual(readinessIndex, -1, "production deploy must run the release-readiness guard");
  assert.notEqual(migrationIndex, -1, "production deploy must retain the Core migration step");
  assert.ok(readinessIndex < migrationIndex, "release readiness must fail closed before any production Core migration");
});

test("different environment-local model versions preserve one HomeMew semantic fingerprint", () => {
  const accepted = acceptedHomeMewModelSemantics(profile);
  assert.equal(accepted.fingerprint, "msf_6dab6ba5b88da89eb608960a5e23feaf7dd0aec4d8f6a0db1defe7ab2a370b22");
  const stagingManifest = accepted.models.map((model) => ({ ...model, version: model.key === "wish" ? 10 : model.key === "task" ? 7 : model.key === "day_record" ? 4 : 6 }));
  const productionManifest = accepted.models.map((model) => ({ ...model, version: model.key === "wish" ? 11 : model.key === "task" ? 8 : model.key === "day_record" ? 5 : 7 }));

  assert.equal(assertHomeMewModelSemanticCompatibility(profile, stagingManifest, "staging mct").fingerprint, accepted.fingerprint);
  assert.equal(assertHomeMewModelSemanticCompatibility(profile, productionManifest, "production mct").fingerprint, accepted.fingerprint);
});

test("HomeMew semantic release gate fails on schema identity drift rather than mct id difference", () => {
  const accepted = acceptedHomeMewModelSemantics(profile);
  const driftedManifest = accepted.models.map((model) => model.key === "wish"
    ? { ...model, schemaHash: "0".repeat(64), version: 99 }
    : { ...model, version: 99 });

  assert.throws(
    () => assertHomeMewModelSemanticCompatibility(profile, driftedManifest, "production mct"),
    /does not match HomeMew semantic fingerprint/u,
  );
});

test("production Model Contract verification matches the current published Registry snapshot exactly", () => {
  const source = readFileSync(fileURLToPath(modelAdminVerifier), "utf8");

  assert.match(source, /actualVersion < expected\.minimumVersion/u, "published production models must satisfy the release floor");
  assert.match(source, /actual\.schemaHash !== expected\.hash/u, "published production models must keep exact schema identity");
  assert.match(source, /currentPublishedModels/u, "production verification must remember actual environment-local published versions");
  assert.match(source, /Number\(model\.version\) !== published\.version/u, "active Model Contract must pin the exact current Registry version");
  assert.match(source, /model\.schemaHash !== published\.schemaHash/u, "active Model Contract must pin the exact current schema hash");
  assert.match(source, /publishedVersion <= currentVersion/u, "semantic reconciliation must remain monotonic");
  assert.match(source, /publishedVersion < expected\.minimumVersion/u, "semantic reconciliation must not publish below the release floor");
  assert.doesNotMatch(source, /expected\.version\s*-\s*1/u, "production must not assume a fixed predecessor version");
  assert.doesNotMatch(source, /Number\(actual\.version\) !== expected\.version/u, "production must not require one exact environment-local published version");
});

test("production HomeMew release gate verifies semantic fingerprint independently from environment-local mct id", () => {
  const source = readFileSync(fileURLToPath(homemewReleaseVerifier), "utf8");

  assert.match(source, /assertHomeMewModelSemanticCompatibility\(profile, manifest\.models/u);
  assert.match(source, /activeModelContract: active\.active_contract_id/u, "production must retain its environment-local immutable mct evidence");
  assert.match(source, /crossEnvironmentMctEqualityRequired: false/u, "production must make the cross-environment representation rule explicit");
  assert.doesNotMatch(source, /acceptedStagingModelContract/u, "production must not require the staging mct id to exist in production");
});

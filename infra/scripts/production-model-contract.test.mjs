import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptedHomeMewModelSemantics,
  assertHomeMewModelSemanticCompatibility,
  calculateModelSemanticFingerprint,
} from "./homemew-contract-identity.mjs";
import { PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";
import { PROVING_MODELS as STAGING_PROVING_MODELS } from "./staging-expectations.mjs";

const modelAdminVerifier = new URL("./verify-production-model-admin.mjs", import.meta.url);
const homemewReleaseVerifier = new URL("./verify-production-homemew-contract.mjs", import.meta.url);
const releaseReadiness = new URL("./check-production-release-readiness.mjs", import.meta.url);
const productionWorkflow = new URL("../../.github/workflows/production-deploy.yml", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));

test("production preflight uses the same candidate semantics that staging must prove", () => {
  assert.equal(PRODUCTION_PROVING_MODELS, STAGING_PROVING_MODELS, "production preflight must evaluate the exact staging candidate semantics before mutation");

  const task = STAGING_PROVING_MODELS.find((model) => model.key === "task");
  assert.deepEqual(
    { minimumVersion: task?.minimumVersion, hash: task?.hash },
    { minimumVersion: 8, hash: "fed3dab27e2f51da3780e42db38dd164fefe39f7d6e7f84161a97e1a8a6d96e6" },
    "schema 42 must prove the description-complete Task semantics",
  );

  const dayRecord = STAGING_PROVING_MODELS.find((model) => model.key === "day_record");
  assert.deepEqual(
    { minimumVersion: dayRecord?.minimumVersion, hash: dayRecord?.hash },
    { minimumVersion: 5, hash: "9dae14eeaef9311412dc910a8976cf85e7d8641792192376ed6678739fe029d1" },
    "schema 42 must prove the description-complete Day Record semantics",
  );

  const candidateFingerprint = calculateModelSemanticFingerprint(
    STAGING_PROVING_MODELS.map((model) => ({ key: model.key, schemaHash: model.hash })),
  );
  assert.equal(candidateFingerprint, "msf_d6b275bf5f4516f057c02a21f89e46de380a71ffa85e9c34a9fbac60f1b60c01");
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

test("unpromoted candidate semantics are rejected by the accepted HomeMew production gate", () => {
  const accepted = acceptedHomeMewModelSemantics(profile);
  assert.equal(accepted.fingerprint, "msf_6dab6ba5b88da89eb608960a5e23feaf7dd0aec4d8f6a0db1defe7ab2a370b22");
  assert.throws(
    () => assertHomeMewModelSemanticCompatibility(
      profile,
      PRODUCTION_PROVING_MODELS.map((model) => ({ key: model.key, schemaHash: model.hash })),
      "unpromoted schema-42 production candidate",
    ),
    /does not match HomeMew semantic fingerprint/u,
  );
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

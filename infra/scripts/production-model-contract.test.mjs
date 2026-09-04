import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptedHomeMewModelSemantics,
  assertHomeMewModelSemanticCompatibility,
} from "./homemew-contract-identity.mjs";
import { PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";

const modelAdminVerifier = new URL("./verify-production-model-admin.mjs", import.meta.url);
const homemewReleaseVerifier = new URL("./verify-production-homemew-contract.mjs", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));

test("production proving models pin semantic identity without assuming environment-local Registry versions", () => {
  const wish = PRODUCTION_PROVING_MODELS.find((model) => model.key === "wish");
  assert.ok(wish, "Wish must remain a production proving model");
  assert.equal(wish.minimumVersion, 5, "Wish clean-release version remains the production Registry floor");
  assert.equal(
    wish.hash,
    "ec4f99f238e44c756905d30a97f6bb5c063b783eca159dfe39f518ea58ff64b6",
    "production must pin the authoritative Mutation Authority Wish schema hash",
  );
  assert.equal("version" in wish, false, "production must not assume one exact environment-local Wish Registry version");
});

test("HomeMew semantic release identity matches production proving route and schema hashes", () => {
  const accepted = acceptedHomeMewModelSemantics(profile);
  assert.equal(accepted.fingerprint, "msf_498674114e2e312c926f733ba939b49d85020a1ee14a4729b27be62bf1f774dc");

  const proving = new Map(PRODUCTION_PROVING_MODELS.map((model) => [model.key, model]));
  for (const model of accepted.models) {
    assert.equal(proving.get(model.key)?.route, model.route, `${model.key} route identity must stay aligned`);
    assert.equal(proving.get(model.key)?.hash, model.schemaHash, `${model.key} schema identity must stay aligned`);
  }
});

test("different environment-local model versions preserve one HomeMew semantic fingerprint", () => {
  const accepted = acceptedHomeMewModelSemantics(profile);
  const stagingManifest = accepted.models.map((model) => ({ ...model, version: model.key === "wish" ? 8 : model.key === "task" ? 5 : model.key === "day_record" ? 2 : 3 }));
  const productionManifest = accepted.models.map((model) => ({ ...model, version: model.key === "wish" ? 6 : model.key === "task" ? 5 : model.key === "day_record" ? 2 : 3 }));

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

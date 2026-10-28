import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";
import { PROVING_MODELS as STAGING_PROVING_MODELS } from "./staging-expectations.mjs";

const modelAdminVerifier = new URL("./verify-production-model-admin.mjs", import.meta.url);
const productionWorkflow = new URL("../../.github/workflows/production-deploy.yml", import.meta.url);

test("production preflight uses the same platform proving semantics as staging", () => {
  assert.equal(
    PRODUCTION_PROVING_MODELS,
    STAGING_PROVING_MODELS,
    "production preflight must evaluate the exact platform semantics proven in staging",
  );

  for (const model of STAGING_PROVING_MODELS) {
    assert.match(model.key, /^[a-z][a-z0-9_]*$/u);
    assert.ok(Number.isInteger(model.minimumVersion) && model.minimumVersion >= 1);
    assert.match(model.hash, /^[a-f0-9]{64}$/u);
  }
});

test("production Model Contract verification matches the current published Registry snapshot exactly", () => {
  const source = readFileSync(fileURLToPath(modelAdminVerifier), "utf8");

  assert.match(source, /LIFESPACE_PRODUCTION_MODEL_ADMIN_BEARER/u, "production requires a pre-provisioned service token");
  assert.match(source, /lsp_svc_/u, "production must use canonical Service Token");
  assert.doesNotMatch(source, /\/bootstrap\/v1\/|BOOTSTRAP_SECRET|wrangler|DELETE FROM|INSERT INTO|app_production_model_probe_/u, "no temporary root identity or production Identity D1 writes");
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

test("production release verifies the platform Model Contract without downstream consumer gates", () => {
  const workflow = readFileSync(fileURLToPath(productionWorkflow), "utf8");

  assert.match(workflow, /node infra\/scripts\/verify-production-model-admin\.mjs/u);
  assert.match(workflow, /LIFESPACE_PRODUCTION_MODEL_ADMIN_BEARER: \$\{\{ secrets\.LIFESPACE_PRODUCTION_MODEL_ADMIN_BEARER \}\}/u);
  assert.match(workflow, /Preflight production Model Admin service token/u);
  assert.match(workflow, /Preflight explicit Bootstrap Secret recovery/u);
  assert.doesNotMatch(workflow, /check-production-release-readiness\.mjs/u, "consumer promotion must not gate platform production release");
});


const REFERENCE_LABEL_RELEASE = Object.freeze({
  task: Object.freeze({ field: "name", minimumVersion: 10 }),
  wish: Object.freeze({ field: "title", minimumVersion: 9 }),
  day_record: Object.freeze({ field: "name", minimumVersion: 7 }),
  event: Object.freeze({ field: "summary", minimumVersion: 8 }),
});

function schema75ReferenceLabelHash(sql, key) {
  const start = sql.indexOf(`-- ${key}:`);
  if (start < 0) throw new Error(`schema 75 is missing ${key} publication`);
  const match = sql.slice(start).match(/'([a-f0-9]{64})','breaking',\s*'service'/u);
  if (!match) throw new Error(`schema 75 has no breaking published hash for ${key}`);
  return match[1];
}

function provingReferenceLabelDrift(models, sql) {
  const byKey = new Map(models.map((model) => [model.key, model]));
  return Object.entries(REFERENCE_LABEL_RELEASE).flatMap(([key, published]) => {
    const actual = byKey.get(key);
    const releasedHash = schema75ReferenceLabelHash(sql, key);
    if (actual?.hash !== releasedHash || actual.minimumVersion < published.minimumVersion) {
      return [`${key} verification does not match schema 75 published reference label`];
    }
    return [];
  });
}

test("staging and production proving-model hashes match schema 75 reference-label publication", () => {
  const migration = readFileSync(new URL("../../apps/core/migrations/0075_baseline_reference_labels.sql", import.meta.url), "utf8");
  const catalog = JSON.parse(readFileSync(new URL("../../apps/core/model-catalog/baseline-models.json", import.meta.url), "utf8"));
  for (const [key, release] of Object.entries(REFERENCE_LABEL_RELEASE)) {
    assert.equal(catalog[key].referenceLabel?.field, release.field, `${key} canonical reference label`);
  }
  assert.deepEqual(provingReferenceLabelDrift(STAGING_PROVING_MODELS, migration), []);
});

test("stale pre-reference-label proving hashes fail the release verification contract", () => {
  const migration = readFileSync(new URL("../../apps/core/migrations/0075_baseline_reference_labels.sql", import.meta.url), "utf8");
  const stale = STAGING_PROVING_MODELS.map((model) => model.key === "task"
    ? { ...model, hash: "8628fc7c392776e943f9279d1841be17983d092f7e3045dce6a976dde9ad39de" }
    : model);
  assert.deepEqual(provingReferenceLabelDrift(stale, migration), [
    "task verification does not match schema 75 published reference label",
  ]);
});

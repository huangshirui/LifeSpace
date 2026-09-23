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
  assert.doesNotMatch(workflow, /check-production-release-readiness\.mjs/u, "consumer promotion must not gate platform production release");
});

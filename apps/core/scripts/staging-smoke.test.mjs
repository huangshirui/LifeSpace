import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = [
  new URL("../../../infra/scripts/prepare-staging-smoke.mjs", import.meta.url),
  new URL("../../../infra/scripts/cleanup-staging-smoke.mjs", import.meta.url),
  new URL("../../../infra/scripts/wait-staging-apac-probe.mjs", import.meta.url),
];
const apacWorkflow = new URL("../../../.github/workflows/apac-performance-gate.yml", import.meta.url);
const apacProbeConfig = new URL("../../../infra/performance-probe/wrangler.jsonc", import.meta.url);

test("authenticated staging smoke scripts remain syntax-valid and staging-only", () => {
  for (const url of scripts) {
    const filename = fileURLToPath(url);
    const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, `${filename} failed node --check: ${result.stderr || result.stdout}`);

    const source = readFileSync(filename, "utf8");
    assert.match(source, /staging/u, `${filename} must remain explicitly staging-scoped`);
    assert.doesNotMatch(source, /--env[\s"',]+production/u, `${filename} must never target Wrangler production`);
    assert.doesNotMatch(source, /core\.aisr\.online/u, `${filename} must never target the production Core hostname`);
    assert.doesNotMatch(source, /auth\.aisr\.online/u, `${filename} must never target the production Identity hostname`);
  }
});

test("staging bootstrap masks ephemeral credentials before job export", () => {
  const source = readFileSync(fileURLToPath(scripts[0]), "utf8");
  assert.match(source, /::add-mask::/u);
  assert.match(source, /GITHUB_ENV/u);
  assert.match(source, /15 \* 60 \* 1000/u, "service PAT should retain a bounded staging-only lifetime");
  assert.match(source, /application_model_access/u, "smoke app model authorization must be explicit");
});

test("APAC performance gate resolves real staging D1 IDs before preparing smoke authority", () => {
  const source = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  const resolveIndex = source.indexOf("node infra/scripts/resolve-staging-d1.mjs");
  const prepareIndex = source.indexOf("node infra/scripts/prepare-staging-smoke.mjs");

  assert.notEqual(resolveIndex, -1, "APAC gate must resolve staging D1 bindings in its ephemeral checkout");
  assert.notEqual(prepareIndex, -1, "APAC gate must prepare staging smoke authority");
  assert.ok(resolveIndex < prepareIndex, "staging D1 bindings must be resolved before prepare-staging-smoke uses wrangler d1 execute");
});

test("APAC performance gate proves the real POST /run path before timed benchmark samples", () => {
  const source = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  const waitIndex = source.indexOf("node infra/scripts/wait-staging-apac-probe.mjs");
  const benchmarkIndex = source.indexOf("node infra/scripts/verify-staging-apac-performance.mjs");

  assert.notEqual(waitIndex, -1, "APAC gate must wait for the actual benchmark route, not health alone");
  assert.notEqual(benchmarkIndex, -1, "APAC gate must run the timed benchmark");
  assert.ok(waitIndex < benchmarkIndex, "real APAC probe route readiness must converge before timed samples start");

  const waitSource = readFileSync(fileURLToPath(scripts[2]), "utf8");
  assert.match(waitSource, /\/run/u, "readiness must exercise the same POST /run entry point used by the benchmark");
  assert.match(waitSource, /tasks\?limit=1/u, "readiness probe must use a read-only Core request");
});

test("APAC performance probe remains deployable on Workers Free", () => {
  const source = readFileSync(fileURLToPath(apacProbeConfig), "utf8");
  const config = JSON.parse(source);

  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.placement, { region: "aws:ap-southeast-1" });
  assert.equal(config.limits, undefined, "Workers Free must use platform-default CPU/subrequest limits instead of custom limits");
});

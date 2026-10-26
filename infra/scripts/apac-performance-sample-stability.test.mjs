import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  APAC_RELEASE_SAMPLE_COUNT,
  targetMet,
  USER_READ_TARGETS,
  USER_MUTATION_TARGETS,
  SERVICE_MUTATION_TARGETS,
} from "./performance-release-targets.mjs";
import { summarize as summarizeUser } from "./staging-canonical-performance-benchmark.mjs";
import { summarize as summarizeService } from "./staging-service-performance-benchmark.mjs";

test("the APAC release sample count does not change either benchmark's percentile targets", () => {
  assert.equal(APAC_RELEASE_SAMPLE_COUNT, 45);
  assert.deepEqual(USER_READ_TARGETS.taskList10, { p50Ms: 150, p90Ms: 250 });
  assert.deepEqual(USER_MUTATION_TARGETS.taskWorkflow, { p50Ms: 160, p90Ms: 250 });
  assert.deepEqual(SERVICE_MUTATION_TARGETS.taskPatch, { p50Ms: 220, p90Ms: 300 });

  const script = readFileSync(new URL("./verify-staging-apac-performance.mjs", import.meta.url), "utf8");
  // Two initial samples configurations plus two targeted confirmation configurations.
  assert.equal((script.match(/sampleCount: APAC_RELEASE_SAMPLE_COUNT,/gu) ?? []).length, 4);
  assert.equal((script.match(/mutationSampleCount: APAC_RELEASE_SAMPLE_COUNT,/gu) ?? []).length, 4);
  assert.match(script, /requirePlatformGoldenFlow\(\)/u);
  assert.match(script, /planApacConfirmation/u);
  assert.match(script, /evaluateApacConfirmation/u);
  assert.match(script, /decision[.]status !== "passed"/u);
});

for (const [label, summarize] of [
  ["user", summarizeUser],
  ["service", summarizeService],
]) {
  test(label + " benchmark still measures nearest-rank p90 without excluding any samples", () => {
    const twoSpikesAt15 = summarize([...Array(13).fill(70), 267, 295]);
    assert.equal(twoSpikesAt15.samples, 15);
    assert.equal(twoSpikesAt15.p90Ms, 267);
    assert.equal(targetMet(twoSpikesAt15, USER_READ_TARGETS.taskList10), false);

    const twoSpikesAt45 = summarize([...Array(43).fill(70), 267, 295]);
    assert.equal(twoSpikesAt45.samples, 45);
    assert.equal(twoSpikesAt45.p90Ms, 70);
    assert.equal(twoSpikesAt45.p99Ms, 295);
    assert.equal(twoSpikesAt45.sampleMs.filter((x) => x > 250).length, 2);
    assert.equal(targetMet(twoSpikesAt45, USER_READ_TARGETS.taskList10), true);

    // 5/45 (11.1%) slow requests still fail the unchanged p90 threshold.
    const persistentTail = summarize([...Array(40).fill(70), ...Array(5).fill(280)]);
    assert.equal(persistentTail.p90Ms, 280);
    assert.equal(targetMet(persistentTail, USER_READ_TARGETS.taskList10), false);

    // A sustained slow central tendency also fails P50, independently of P90.
    const slowMedian = summarize(Array(45).fill(180));
    assert.equal(targetMet(slowMedian, USER_READ_TARGETS.taskList10), false);
  });
}

test("standalone APAC staging diagnostics is owner-dispatched and cannot substitute production promotion", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/staging-apac-diagnostics.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\s*\n  workflow_dispatch:\s*$/mu);
  assert.match(workflow, /test "\$GITHUB_ACTOR" = "huangshirui"/u);
  assert.match(workflow, /test "\$GITHUB_TRIGGERING_ACTOR" = "huangshirui"/u);
  assert.match(workflow, /test "\$GITHUB_REF_NAME" = "main"/u);
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /group: lifespace-staging-apac-performance/u);
  assert.match(workflow, /verify-staging-candidate-identity[.]mjs/u);
  assert.match(workflow, /verify-staging-apac-performance[.]mjs/u);
  assert.match(workflow, /if: \$\{\{ always\(\) &&/u);
  assert.doesNotMatch(workflow, /^    deploy:/mu);
  assert.doesNotMatch(workflow, /environment: production/u);
  assert.doesNotMatch(workflow, /workflow_run:|repository_dispatch:|(^|\n)  push:|(^|\n)  pull_request:/u);
});

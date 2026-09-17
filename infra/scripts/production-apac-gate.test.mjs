import assert from "node:assert/strict";
import test from "node:test";
import {
  APAC_GATE_WORKFLOW_NAME,
  APAC_GATE_WORKFLOW_PATH,
  assertProductionApacGateRun,
  parseApacGateRunId,
} from "./verify-production-apac-gate.mjs";

const candidateSha = "a".repeat(40);
const repository = "huangshirui/LifeSpace";
const nowMs = Date.parse("2026-09-17T16:00:00Z");

function validRun(overrides = {}) {
  return {
    id: 12345,
    name: APAC_GATE_WORKFLOW_NAME,
    path: APAC_GATE_WORKFLOW_PATH,
    run_number: 99,
    run_attempt: 1,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: candidateSha,
    run_started_at: "2026-09-17T15:30:00Z",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    ...overrides,
  };
}

function verify(run, overrides = {}) {
  return assertProductionApacGateRun(run, {
    repository,
    candidateSha,
    nowMs,
    ...overrides,
  });
}

test("accepts a fresh successful APAC gate for the exact production SHA", () => {
  assert.deepEqual(verify(validRun()), {
    runId: 12345,
    runNumber: 99,
    runAttempt: 1,
    headSha: candidateSha,
    headBranch: "main",
    runStartedAt: "2026-09-17T15:30:00Z",
    workflow: APAC_GATE_WORKFLOW_NAME,
  });
});

test("rejects stale, failed, wrong-workflow, wrong-branch and wrong-SHA runs", () => {
  assert.throws(() => verify(validRun({ conclusion: "failure" })), /did not complete successfully/u);
  assert.throws(() => verify(validRun({ name: "Check" })), /workflow name mismatch/u);
  assert.throws(() => verify(validRun({ path: ".github/workflows/check.yml" })), /workflow path mismatch/u);
  assert.throws(() => verify(validRun({ event: "push" })), /explicitly dispatched/u);
  assert.throws(() => verify(validRun({ head_branch: "feature" })), /must target main/u);
  assert.throws(() => verify(validRun({ head_sha: "b".repeat(40) })), /candidate mismatch/u);
  assert.throws(() => verify(validRun({ run_started_at: "2026-09-16T14:00:00Z" })), /stale/u);
});

test("rejects a run from another repository", () => {
  assert.throws(() => verify(validRun({ repository: { full_name: "other/repo" } })), /repository mismatch/u);
  assert.throws(() => verify(validRun({ head_repository: { full_name: "other/repo" } })), /repository mismatch/u);
});

test("requires a positive integer workflow run ID", () => {
  assert.equal(parseApacGateRunId("35230784152"), "35230784152");
  for (const value of ["", "0", "-1", "1.5", "abc", null]) {
    assert.throws(() => parseApacGateRunId(value), /positive integer/u);
  }
});

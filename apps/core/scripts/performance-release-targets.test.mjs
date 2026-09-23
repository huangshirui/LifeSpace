import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTargets,
  SERVICE_MUTATION_TARGETS,
  SERVICE_READ_TARGETS,
  targetMet,
  USER_MUTATION_TARGETS,
  USER_READ_TARGETS,
} from "../../../infra/scripts/performance-release-targets.mjs";

test("current APAC release targets preserve scenario-specific headroom", () => {
  assert.deepEqual(USER_READ_TARGETS.taskGet, { p50Ms: 150, p90Ms: 250 });
  assert.deepEqual(USER_READ_TARGETS.taskList10, { p50Ms: 150, p90Ms: 250 });
  assert.deepEqual(USER_READ_TARGETS.eventWindow, { p50Ms: 150, p90Ms: 250 });
  assert.deepEqual(USER_READ_TARGETS.dayRecordList, { p50Ms: 220, p90Ms: 300 });
  assert.deepEqual(USER_READ_TARGETS.wishList, { p50Ms: 150, p90Ms: 250 });
  assert.deepEqual(USER_MUTATION_TARGETS.taskPatch, { p50Ms: 160, p90Ms: 250 });
  assert.deepEqual(USER_MUTATION_TARGETS.taskWorkflow, { p50Ms: 160, p90Ms: 250 });
  assert.deepEqual(SERVICE_READ_TARGETS.taskGet, { p50Ms: 180, p90Ms: 250 });
  assert.deepEqual(SERVICE_READ_TARGETS.taskList10, { p50Ms: 180, p90Ms: 250 });
  assert.deepEqual(SERVICE_MUTATION_TARGETS.taskCreate, { p50Ms: 220, p90Ms: 300 });
  assert.deepEqual(SERVICE_MUTATION_TARGETS.taskPatch, { p50Ms: 220, p90Ms: 300 });
  assert.deepEqual(SERVICE_MUTATION_TARGETS.taskWorkflow, { p50Ms: 220, p90Ms: 300 });
});

test("release target evaluation fails either P50 or P90 regressions", () => {
  assert.equal(targetMet({ p50Ms: 150, p90Ms: 250 }, USER_READ_TARGETS.taskGet), true);
  assert.equal(targetMet({ p50Ms: 151, p90Ms: 200 }, USER_READ_TARGETS.taskGet), false);
  assert.equal(targetMet({ p50Ms: 100, p90Ms: 251 }, USER_READ_TARGETS.taskGet), false);

  assert.deepEqual(
    evaluateTargets(
      {
        taskGet: { p50Ms: 100, p90Ms: 200 },
        taskList10: { p50Ms: 181, p90Ms: 200 },
      },
      SERVICE_READ_TARGETS,
    ),
    { taskGet: true, taskList10: false },
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isAllowedBenchmarkRequest } from "../../../infra/performance-probe/worker.mjs";

const spaceId = "spc_probe_test";
const recordId = "rec_abc123";
const base = `/api/v1/spaces/${spaceId}`;

test("APAC performance probe accepts the canonical modelKey Runtime surface", () => {
  const allowed = [
    ["POST", `${base}/models/task/records`],
    ["GET", `${base}/models/task/records?limit=1`],
    ["GET", `${base}/models/task/records/${recordId}`],
    ["PATCH", `${base}/models/task/records/${recordId}`],
    ["DELETE", `${base}/models/task/records/${recordId}`],
    ["POST", `${base}/models/task/records/${recordId}/actions/complete`],
    ["POST", `${base}/models/task/records/${recordId}/actions/reopen`],
    ["POST", `${base}/models/event/records`],
    ["GET", `${base}/models/event/records?limit=1`],
    ["POST", `${base}/models/event/records/query`],
    ["DELETE", `${base}/models/event/records/${recordId}`],
    ["POST", `${base}/models/day_record/records`],
    ["GET", `${base}/models/day_record/records?limit=1`],
    ["DELETE", `${base}/models/day_record/records/${recordId}`],
    ["POST", `${base}/models/wish/records`],
    ["GET", `${base}/models/wish/records?limit=1`],
    ["DELETE", `${base}/models/wish/records/${recordId}`],
  ];

  for (const [method, path] of allowed) {
    assert.equal(isAllowedBenchmarkRequest(path, method, spaceId), true, `${method} ${path} should be allowed`);
  }
});

test("APAC performance probe does not benchmark retired v1 aliases or arbitrary model paths", () => {
  const denied = [
    ["GET", `${base}/tasks`],
    ["POST", `${base}/tasks`],
    ["DELETE", `${base}/tasks/${recordId}`],
    ["GET", `${base}/events`],
    ["DELETE", `${base}/events/${recordId}`],
    ["GET", `${base}/day-records`],
    ["DELETE", `${base}/day-records/${recordId}`],
    ["GET", `${base}/wishes`],
    ["DELETE", `${base}/wishes/${recordId}`],
    ["GET", `${base}/models/unknown/records`],
    ["POST", `${base}/models/event/records/${recordId}/actions/anything`],
  ];

  for (const [method, path] of denied) {
    assert.equal(isAllowedBenchmarkRequest(path, method, spaceId), false, `${method} ${path} should be denied`);
  }
});

test("APAC user benchmark exercises Event v6 TemporalRange through Canonical Query", () => {
  const benchmark = readFileSync(new URL("../../../infra/scripts/staging-canonical-performance-benchmark.mjs", import.meta.url), "utf8");
  assert.match(benchmark, /when:\s*\{\s*kind:\s*"instant"/u);
  assert.match(benchmark, /models\/event\/records\/query/u);
  assert.match(benchmark, /field:\s*"when",\s*op:\s*"overlaps"/u);
  assert.doesNotMatch(benchmark, /isAllDay/u);
  assert.doesNotMatch(benchmark, /rangeStart=/u);
  assert.match(benchmark, /mutationSampleCount\s*=\s*DEFAULT_MUTATION_SAMPLE_COUNT/u);
  assert.match(benchmark, /DEFAULT_MUTATION_SAMPLE_COUNT\s*=\s*15/u);
});

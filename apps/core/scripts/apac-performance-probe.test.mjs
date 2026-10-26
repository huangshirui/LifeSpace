import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { handleProbeRequest, isAllowedBenchmarkRequest } from "../../../infra/performance-probe/worker.mjs";

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


test("APAC release gate re-proves platform Golden Flow before timed performance acceptance", () => {
  const verifier = readFileSync(new URL("../../../infra/scripts/verify-staging-apac-performance.mjs", import.meta.url), "utf8");
  const goldenFlowIndex = verifier.indexOf("requirePlatformGoldenFlow();");
  const userBenchmarkIndex = verifier.indexOf("const userResult = await runStagingPerformanceBenchmark");
  const serviceBenchmarkIndex = verifier.indexOf("const serviceResult = await runStagingServicePerformanceBenchmark");

  assert.match(verifier, /verify-staging-platform-golden-flow\.mjs/u);
  assert.match(verifier, /spawnSync\(process\.execPath/u);
  assert.notEqual(goldenFlowIndex, -1, "APAC promotion gate must invoke the platform Golden Flow");
  assert.notEqual(userBenchmarkIndex, -1, "APAC promotion gate must retain user benchmark");
  assert.notEqual(serviceBenchmarkIndex, -1, "APAC promotion gate must retain Service benchmark");
  assert.ok(goldenFlowIndex < userBenchmarkIndex, "platform Golden Flow must pass before user performance acceptance");
  assert.ok(goldenFlowIndex < serviceBenchmarkIndex, "platform Golden Flow must pass before Service performance acceptance");
});


test("APAC release gate enforces scenario targets for reads and mutations", () => {
  const userBenchmark = readFileSync(new URL("../../../infra/scripts/staging-canonical-performance-benchmark.mjs", import.meta.url), "utf8");
  const serviceBenchmark = readFileSync(new URL("../../../infra/scripts/staging-service-performance-benchmark.mjs", import.meta.url), "utf8");
  const verifier = readFileSync(new URL("../../../infra/scripts/verify-staging-apac-performance.mjs", import.meta.url), "utf8");

  assert.match(userBenchmark, /DEFAULT_MUTATION_SAMPLE_COUNT\s*=\s*15/u);
  assert.match(serviceBenchmark, /DEFAULT_MUTATION_SAMPLE_COUNT\s*=\s*15/u);
  assert.match(userBenchmark, /mutationTargetsMet/u);
  assert.match(serviceBenchmark, /mutationTargetsMet/u);
  // Confirmation still enforces every scenario target without trimming latency samples.
  assert.match(verifier, /planApacConfirmation/u);
  assert.match(verifier, /evaluateApacConfirmation/u);
  assert.match(verifier, /decision[.]status !== "passed"/u);
  assert.doesNotMatch(verifier, /allReadTargetsMet\)\s*\{/u);
});

test("APAC probe correlates each allowed Core request without exposing authorization", async () => {
  let coreRequestId;
  const request = new Request("https://probe.example/run", {
    method: "POST",
    headers: { "x-lifespace-probe-token": "test-probe-secret", "content-type": "application/json" },
    body: JSON.stringify({
      method: "GET",
      path: `${base}/models/task/records/${recordId}`,
      credentialMode: "user",
    }),
  });
  const result = await handleProbeRequest(request, {
    PROBE_TOKEN: "test-probe-secret",
    USER_BEARER: "test-user-secret",
    SERVICE_BEARER: "test-service-secret",
    SPACE_ID: spaceId,
  }, async (_url, options) => {
    coreRequestId = options.headers["x-request-id"];
    assert.match(coreRequestId, /^[0-9a-f-]{36}$/u);
    assert.equal(options.headers.authorization, "Bearer test-user-secret");
    return new Response(JSON.stringify({ data: { id: recordId } }), {
      status: 200, headers: { "x-request-id": coreRequestId },
    });
  });
  const output = await result.json();
  assert.equal(output.status, 200);
  assert.equal(output.coreRequestId, coreRequestId);
  assert.equal(typeof output.elapsedMs, "number");
  assert.doesNotMatch(JSON.stringify(output), /test-user-secret|test-probe-secret/u);
});

test("APAC probe fails closed on a mismatched Core correlation header", async () => {
  const request = new Request("https://probe.example/run", {
    method: "POST",
    headers: { "x-lifespace-probe-token": "test-probe-secret", "content-type": "application/json" },
    body: JSON.stringify({
      method: "GET",
      path: `${base}/models/task/records/${recordId}`,
    }),
  });
  const response = await handleProbeRequest(request, {
    PROBE_TOKEN: "test-probe-secret",
    USER_BEARER: "test-user-secret",
    SERVICE_BEARER: "test-service-secret",
    SPACE_ID: spaceId,
  }, async () => new Response(JSON.stringify({ data: {} }), {
    status: 200, headers: { "x-request-id": "untrusted-mismatch" },
  }));
  const output = await response.json();
  assert.equal(output.status, 200);
  assert.equal(output.coreRequestId, null);
});

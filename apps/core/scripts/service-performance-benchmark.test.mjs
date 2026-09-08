import assert from "node:assert/strict";
import test from "node:test";
import { runStagingServicePerformanceBenchmark } from "../../../infra/scripts/staging-service-performance-benchmark.mjs";

function benchmarkAdapter() {
  const records = new Map();
  const requests = [];
  let sequence = 0;

  function response(status, data, elapsedMs = 10) {
    return { status, payload: data === undefined ? null : { data }, elapsedMs };
  }

  return {
    requests,
    async request(path, { method = "GET", body } = {}) {
      requests.push({ path, method, body });
      const url = new URL(path, "https://core-staging.example.test");
      const collection = "/api/v1/spaces/spc_test/tasks";

      if (url.pathname === collection && method === "POST") {
        sequence += 1;
        const record = { id: `rec_test${sequence}`, version: 1, name: body?.name ?? "" };
        records.set(record.id, record);
        return response(201, record);
      }
      if (url.pathname === collection && method === "GET") {
        return response(200, [...records.values()].slice(0, 10));
      }

      const recordMatch = new RegExp(`^${collection}/(rec_test\\d+)$`, "u").exec(url.pathname);
      if (recordMatch) {
        const record = records.get(recordMatch[1]);
        if (!record) return response(404, undefined);
        if (method === "GET") return response(200, record);
        if (method === "PATCH") {
          assert.equal(body?.version, record.version);
          const updated = { ...record, ...body, version: record.version + 1 };
          delete updated.version;
          updated.version = record.version + 1;
          records.set(record.id, updated);
          return response(200, updated);
        }
        if (method === "DELETE") {
          assert.equal(body?.version, record.version);
          records.delete(record.id);
          return response(204, undefined);
        }
      }

      const actionMatch = new RegExp(`^${collection}/(rec_test\\d+)/actions/(complete|reopen)$`, "u").exec(url.pathname);
      if (actionMatch && method === "POST") {
        const record = records.get(actionMatch[1]);
        if (!record) return response(404, undefined);
        assert.equal(body?.version, record.version);
        const updated = { ...record, version: record.version + 1, status: actionMatch[2] === "complete" ? "completed" : "pending" };
        records.set(record.id, updated);
        return response(200, updated);
      }

      throw new Error(`Unexpected benchmark request ${method} ${path}`);
    },
  };
}

test("Service PAT benchmark covers bounded Task read/create/update/action requests and cleans up", async () => {
  const adapter = benchmarkAdapter();
  const result = await runStagingServicePerformanceBenchmark({
    coreBaseUrl: "https://core-staging.example.test",
    bearer: "lsp_pat_test_only_not_a_real_secret",
    spaceId: "spc_test",
    benchmarkProfile: "apac",
    source: "unit-test APAC-shaped adapter",
    requestAdapter: adapter.request,
    sampleCount: 2,
    warmupCount: 1,
    mutationSampleCount: 2,
  });

  assert.equal(result.credentialMode, "opaque_service_api_token");
  assert.equal(result.acceptanceEligible, true);
  assert.equal(result.allReadTargetsMet, true);
  assert.deepEqual(result.readTargetsMet, { taskGet: true, taskList10: true });
  assert.equal(result.reads.taskGet.samples, 2);
  assert.equal(result.reads.taskList10.samples, 2);
  assert.equal(result.mutations.taskCreate.samples, 2);
  assert.equal(result.mutations.taskPatch.samples, 2);
  assert.equal(result.mutations.taskWorkflow.samples, 2);

  assert.equal(adapter.requests.filter((entry) => entry.method === "POST" && /\/tasks$/u.test(new URL(entry.path, "https://x.test").pathname)).length, 5);
  assert.equal(adapter.requests.filter((entry) => entry.method === "PATCH").length, 2);
  assert.equal(adapter.requests.filter((entry) => /\/actions\/(complete|reopen)$/u.test(entry.path)).length, 2);
  assert.equal(adapter.requests.filter((entry) => entry.method === "DELETE").length, 5);
});

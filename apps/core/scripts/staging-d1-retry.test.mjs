import assert from "node:assert/strict";
import test from "node:test";
import { executeStagingD1Sql, isRetryableStagingD1Error } from "../../../infra/scripts/staging-d1-retry.mjs";

function d1Error(text) {
  const error = new Error("wrangler d1 execute failed");
  error.stdout = text;
  return error;
}

test("classifies Cloudflare D1 7429 storage timeouts as retryable", () => {
  assert.equal(isRetryableStagingD1Error(d1Error("D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]")), true);
  assert.equal(isRetryableStagingD1Error(d1Error('{"error":{"code":7429}}')), true);
  assert.equal(isRetryableStagingD1Error(d1Error("SQLITE_CONSTRAINT: UNIQUE constraint failed")), false);
});

test("retries a transient 7429 once and returns the successful D1 result", async () => {
  let calls = 0;
  const sleeps = [];
  const entries = await executeStagingD1Sql({
    cwd: new URL("../", import.meta.url),
    sql: "SELECT 1",
    exec() {
      calls += 1;
      if (calls === 1) throw d1Error("D1 DB storage operation exceeded timeout which caused object to be reset. [code: 7429]");
      return JSON.stringify([{ success: true, results: [{ value: 1 }] }]);
    },
    sleep: async (delay) => { sleeps.push(delay); },
  });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(entries[0].success, true);
});

test("does not retry semantic D1 failures", async () => {
  let calls = 0;
  await assert.rejects(
    executeStagingD1Sql({
      cwd: new URL("../", import.meta.url),
      sql: "INSERT INTO example VALUES (1)",
      exec() {
        calls += 1;
        throw d1Error("SQLITE_CONSTRAINT: UNIQUE constraint failed");
      },
      sleep: async () => { throw new Error("sleep must not be called"); },
    }),
    /wrangler d1 execute failed/u,
  );
  assert.equal(calls, 1);
});

test("fails after the bounded retry budget is exhausted", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    executeStagingD1Sql({
      cwd: new URL("../", import.meta.url),
      sql: "SELECT 1",
      attempts: 3,
      delayMs: 10,
      exec() {
        calls += 1;
        throw d1Error('[code: 7429]');
      },
      sleep: async (delay) => { sleeps.push(delay); },
    }),
    /wrangler d1 execute failed/u,
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

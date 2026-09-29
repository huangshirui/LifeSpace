import assert from "node:assert/strict";
import test from "node:test";
import { requestWithStagingAuthConvergence } from "./staging-auth-convergence.mjs";

function response(status) {
  return { response: { status } };
}

test("retries transient 401 until authentication converges", async () => {
  const statuses = [401, 401, 200];
  const sleeps = [];
  let calls = 0;

  const result = await requestWithStagingAuthConvergence({
    request: async () => {
      const value = response(statuses[calls]);
      calls += 1;
      return value;
    },
    sleep: async (ms) => sleeps.push(ms),
  });

  assert.equal(result.response.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("GET retries transient 5xx", async () => {
  const statuses = [503, 200];
  let calls = 0;

  const result = await requestWithStagingAuthConvergence({
    method: "GET",
    request: async () => response(statuses[calls++]),
    sleep: async () => {},
  });

  assert.equal(result.response.status, 200);
  assert.equal(calls, 2);
});

test("POST does not replay ambiguous 5xx mutations", async () => {
  let calls = 0;
  const result = await requestWithStagingAuthConvergence({
    method: "POST",
    request: async () => {
      calls += 1;
      return response(503);
    },
    sleep: async () => {
      throw new Error("must not sleep");
    },
  });

  assert.equal(result.response.status, 503);
  assert.equal(calls, 1);
});

test("POST may retry explicit unauthenticated 401", async () => {
  const statuses = [401, 201];
  let calls = 0;

  const result = await requestWithStagingAuthConvergence({
    method: "POST",
    request: async () => response(statuses[calls++]),
    sleep: async () => {},
  });

  assert.equal(result.response.status, 201);
  assert.equal(calls, 2);
});

test("persistent authorization failures are not weakened into success", async () => {
  let calls = 0;
  const result = await requestWithStagingAuthConvergence({
    attempts: 3,
    request: async () => {
      calls += 1;
      return response(401);
    },
    sleep: async () => {},
  });

  assert.equal(result.response.status, 401);
  assert.equal(calls, 3);
});

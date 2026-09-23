import assert from "node:assert/strict";
import test from "node:test";
import { assertStagingStatus } from "./verify-staging-candidate-identity.mjs";

const expected = { schemaVersion: 43, contractVersion: "0.38.0" };

function payload(overrides = {}) {
  return {
    data: {
      environment: "staging",
      schemaVersion: 43,
      contractVersion: "0.38.0",
      ...overrides,
    },
  };
}

test("accepts live staging status that matches checkout expectations", () => {
  assert.deepEqual(assertStagingStatus(payload(), expected, "Core"), {
    environment: "staging",
    schemaVersion: 43,
    contractVersion: "0.38.0",
  });
});

test("rejects environment, schema and contract drift", () => {
  assert.throws(() => assertStagingStatus(payload({ environment: "production" }), expected, "Core"), /environment mismatch/u);
  assert.throws(() => assertStagingStatus(payload({ schemaVersion: 40 }), expected, "Core"), /schema mismatch/u);
  assert.throws(() => assertStagingStatus(payload({ contractVersion: "0.35.0" }), expected, "Core"), /contract mismatch/u);
  assert.throws(() => assertStagingStatus({}, expected, "Core"), /missing data/u);
});

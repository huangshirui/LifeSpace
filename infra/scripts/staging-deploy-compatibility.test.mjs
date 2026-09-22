import test from "node:test";
import assert from "node:assert/strict";
import {
  assertStagingCandidateNotOlder,
  compareContractVersions,
} from "./verify-staging-candidate-compatibility.mjs";

test("compares contract versions numerically", () => {
  assert.equal(compareContractVersions("0.36.0", "0.35.0"), 1);
  assert.equal(compareContractVersions("0.36.0", "0.36.0"), 0);
  assert.equal(compareContractVersions("0.35.0", "0.36.0"), -1);
});

test("allows a candidate at or ahead of live staging", () => {
  const result = assertStagingCandidateNotOlder({
    service: "core",
    live: { data: { status: "ok", environment: "staging", schemaVersion: 40, contractVersion: "0.35.0" } },
    expectedContractVersion: "0.36.0",
    expectedSchemaVersion: 42,
  });
  assert.equal(result.expectedSchemaVersion, 42);
});

test("rejects a schema downgrade before deployment", () => {
  assert.throws(
    () => assertStagingCandidateNotOlder({
      service: "core",
      live: { data: { status: "ok", environment: "staging", schemaVersion: 42, contractVersion: "0.36.0" } },
      expectedContractVersion: "0.36.0",
      expectedSchemaVersion: 40,
    }),
    /schema 42 is newer than candidate schema 40/,
  );
});

test("rejects a contract downgrade before deployment", () => {
  assert.throws(
    () => assertStagingCandidateNotOlder({
      service: "core",
      live: { data: { status: "ok", environment: "staging", schemaVersion: 42, contractVersion: "0.37.0" } },
      expectedContractVersion: "0.36.0",
      expectedSchemaVersion: 42,
    }),
    /contract 0.37.0 is newer than candidate contract 0.36.0/,
  );
});

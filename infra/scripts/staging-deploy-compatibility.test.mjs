import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertStagingCandidateNotOlder,
  compareContractVersions,
} from "./verify-staging-candidate-compatibility.mjs";

test("compares contract versions numerically", () => {
  assert.equal(compareContractVersions("0.37.0", "0.36.0"), 1);
  assert.equal(compareContractVersions("0.37.0", "0.37.0"), 0);
  assert.equal(compareContractVersions("0.36.0", "0.37.0"), -1);
});

test("allows a candidate at or ahead of live staging", () => {
  const result = assertStagingCandidateNotOlder({
    service: "core",
    live: { data: { status: "ok", environment: "staging", schemaVersion: 40, contractVersion: "0.35.0" } },
    expectedContractVersion: "0.37.0",
    expectedSchemaVersion: 43,
  });
  assert.equal(result.expectedSchemaVersion, 43);
});

test("rejects a schema downgrade before deployment", () => {
  assert.throws(
    () => assertStagingCandidateNotOlder({
      service: "core",
      live: { data: { status: "ok", environment: "staging", schemaVersion: 43, contractVersion: "0.36.0" } },
      expectedContractVersion: "0.37.0",
      expectedSchemaVersion: 40,
    }),
    /schema 43 is newer than candidate schema 40/,
  );
});

test("rejects a contract downgrade before deployment", () => {
  assert.throws(
    () => assertStagingCandidateNotOlder({
      service: "core",
      live: { data: { status: "ok", environment: "staging", schemaVersion: 43, contractVersion: "0.38.0" } },
      expectedContractVersion: "0.37.0",
      expectedSchemaVersion: 43,
    }),
    /contract 0.38.0 is newer than candidate contract 0.37.0/,
  );
});

test("dynamic External staging smoke waits past the Runtime Registry TTL after publishing its run-scoped Definition", () => {
  const smoke = readFileSync(new URL("./verify-staging-external-self-service.mjs", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../../apps/core/src/model-registry.ts", import.meta.url), "utf8");
  assert.match(registry, /const RUNTIME_REGISTRY_TTL_MS = 60_000;/u);
  const publish = smoke.indexOf('await expectRequest("/api/v1/model-admin/models"');
  const barrier = smoke.indexOf("setTimeout(resolve, 65_000)");
  const bind = smoke.indexOf("const bound = await expectRequest(`${base}/external-models`");
  assert.ok(publish >= 0 && barrier > publish && bind > barrier, "External smoke must wait beyond Registry TTL between Definition publication and binding/runtime checks");
});

test("dynamic External staging smoke keeps binding origin in configuration but runtime records origin-neutral", () => {
  const smoke = readFileSync(new URL("./verify-staging-external-self-service.mjs", import.meta.url), "utf8");
  assert.match(smoke, /assert\.equal\(bound\.origin, "external"\)/u);
  assert.match(smoke, /assert\.equal\(record\.origin, undefined\)/u);
  assert.match(smoke, /assert\.equal\(record\.schemaHash, undefined\)/u);
  assert.match(smoke, /assert\.equal\(fetched\.origin, undefined\)/u);
  assert.match(smoke, /assert\.equal\(fetched\.schemaHash, undefined\)/u);
  assert.doesNotMatch(smoke, /assert\.equal\(record\.origin, "external"\)/u);
});

test("dynamic External staging smoke treats read downgrade as capability removal and preserves primary failures", () => {
  const smoke = readFileSync(new URL("./verify-staging-external-self-service.mjs", import.meta.url), "utf8");
  assert.match(smoke, /assert\.equal\(writeWhileRead\.status, 405,/u);
  assert.match(smoke, /writeWhileRead\.payload\?\.error\?\.code, "MODEL_OPERATION_UNSUPPORTED"/u);
  assert.match(smoke, /cleanupFailures\.push\(`\$\{label\}: \$\{errorText\(error\)\}`\)/u);
  const restore = smoke.indexOf('body: { access: "write", status: "active" }');
  const providerDelete = smoke.indexOf('const result = await request(`${base}/models/${definitionKey}/records/${id}`, { method: "DELETE", body: {} });', restore);
  assert.ok(restore >= 0 && providerDelete > restore, "Cleanup must restore write capability before deleting synthetic Provider records left by a mid-flow failure");
  const primaryFailure = smoke.indexOf("if (failure) {");
  const cleanupOnlyFailure = smoke.indexOf("\nif (cleanupFailures.length) {\n  throw new Error", primaryFailure);
  assert.ok(primaryFailure >= 0 && cleanupOnlyFailure > primaryFailure, "Primary Dynamic External failure must be rethrown before a cleanup-only failure can replace it");
});

test("dynamic External staging smoke restores a Provider field rename on failure", () => {
  const smoke = readFileSync(new URL("./verify-staging-external-self-service.mjs", import.meta.url), "utf8");
  const renamed = smoke.indexOf("startDateRenamed = true;");
  const cleanup = smoke.indexOf('await cleanup("synthetic Provider property-name restore"');
  const restore = smoke.indexOf("[renamedStartDateProperty]: { name: startDateProperty }", cleanup);
  assert.ok(renamed >= 0 && cleanup > renamed && restore > cleanup, "Synthetic Provider property rename must have a failure-path restore");
});

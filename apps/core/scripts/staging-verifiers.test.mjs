import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = [
  new URL("../../../infra/scripts/staging-expectations.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-staging-db.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-staging-http.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-staging-models.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-staging-creation-draft.mjs", import.meta.url),
];

test("staging verifier scripts remain valid Node syntax", () => {
  for (const script of scripts) {
    const path = fileURLToPath(script);
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ["--check", path], { stdio: ["ignore", "pipe", "pipe"] });
    }, `node --check failed for ${path}`);
  }
});

test("staging expectations derive contract/schema versions from repository sources", async () => {
  const { STAGING_EXPECTATIONS } = await import("../../../infra/scripts/staging-expectations.mjs");
  assert.match(STAGING_EXPECTATIONS.core.contractVersion, /^\d+\.\d+\.\d+$/u);
  assert.match(STAGING_EXPECTATIONS.identity.contractVersion, /^\d+\.\d+\.\d+$/u);
  assert.ok(STAGING_EXPECTATIONS.core.schemaVersion >= 1);
  assert.ok(STAGING_EXPECTATIONS.identity.schemaVersion >= 1);
});

test("staging expectations reject a latest migration that does not advance schema metadata", async () => {
  const { assertSchemaMetadataAdvance } = await import("../../../infra/scripts/staging-expectations.mjs");
  assert.doesNotThrow(() => {
    assertSchemaMetadataAdvance(
      "UPDATE schema_metadata SET value='40' WHERE key='schema_version';",
      40,
      "synthetic migration",
    );
  });
  assert.throws(
    () => assertSchemaMetadataAdvance(
      "CREATE TABLE missing_version_marker (id TEXT PRIMARY KEY);",
      40,
      "synthetic migration",
    ),
    /must advance schema_metadata schema_version to 40/u,
  );
});

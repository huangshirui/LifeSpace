import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
const source = readFileSync(fileURLToPath(new URL("../migrations/0050_non_atomic_bulk.sql", import.meta.url)), "utf8");
test("schema 50 adds independent Bulk correlation without rewriting existing authority/history tables", () => {
  assert.match(source, /CREATE TABLE resource_bulk_requests/u);
  assert.match(source, /ADD COLUMN bulk_id/u);
  assert.match(source, /CHANGE_GROUPING_CONFLICT/u);
  assert.doesNotMatch(source, /DROP\s+TABLE\s+(resource_changes|resource_change_sets|domain_event_outbox|delegations)/iu);
  assert.match(source, /UPDATE\s+schema_metadata\s+SET\s+value='50'/iu);
});

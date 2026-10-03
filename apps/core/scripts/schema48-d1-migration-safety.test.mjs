import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const migration = new URL("../migrations/0048_authority_role_capability_redelegation.sql", import.meta.url);
const source = readFileSync(fileURLToPath(migration), "utf8");

test("schema 48 never rebuilds the heavily referenced resource_records parent", () => {
  assert.doesNotMatch(source, /PRAGMA\s+foreign_keys\s*=\s*OFF/iu);
  assert.doesNotMatch(source, /DROP\s+TABLE\s+resource_records/iu);
  assert.doesNotMatch(source, /_migration_0048_resource_records/iu);
  assert.match(source, /ALTER\s+TABLE\s+resource_records\s+ADD\s+COLUMN\s+created_by_entity_type\s+TEXT/iu);
  assert.match(source, /ALTER\s+TABLE\s+resource_records\s+ADD\s+COLUMN\s+updated_by_entity_type\s+TEXT/iu);
  assert.match(source, /created_by_entity_type=created_by_type/iu);
  assert.match(source, /updated_by_entity_type=updated_by_type/iu);
});

test("schema 48 Eventing emits the exact Entity Type rather than the legacy carrier", () => {
  assert.match(source, /COALESCE\(NEW\.created_by_entity_type,NEW\.created_by_type\)/u);
  assert.match(source, /COALESCE\(NEW\.updated_by_entity_type,NEW\.updated_by_type\)/u);
});

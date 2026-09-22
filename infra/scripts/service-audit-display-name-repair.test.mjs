import assert from "node:assert/strict";
import test from "node:test";
import {
  AUDIT_NAME_TARGETS,
  brokenServiceIdsQuery,
  repairStatement,
  unresolvedCountQuery,
} from "./service-audit-display-name-repair.mjs";

test("service audit repair targets all current friendly-name snapshots", () => {
  assert.deepEqual(
    AUDIT_NAME_TARGETS.map(({ table, name }) => `${table}.${name}`),
    [
      "resource_records.created_by_name_snapshot",
      "resource_records.updated_by_name_snapshot",
      "temporal_occurrences.recorded_by_name_snapshot",
      "model_definitions.published_by_name_snapshot",
      "model_contract_revisions.created_by_name_snapshot",
      "model_definition_drafts.created_by_name_snapshot",
    ],
  );
});

test("repair only replaces the known broken service-id snapshot shape", () => {
  const target = AUDIT_NAME_TARGETS[0];
  const sql = repairStatement(target, "svc_example", "Home n8n");
  assert.match(sql, /created_by_type='service'/u);
  assert.match(sql, /created_by_id='svc_example'/u);
  assert.match(sql, /created_by_name_snapshot=created_by_id/u);
  assert.match(sql, /SET created_by_name_snapshot='Home n8n'/u);
});

test("discovery and verification queries use the same broken-snapshot predicate", () => {
  const discovery = brokenServiceIdsQuery();
  const verification = unresolvedCountQuery();
  for (const target of AUDIT_NAME_TARGETS) {
    assert.match(discovery, new RegExp(`${target.name}=${target.id}`, "u"));
    assert.match(verification, new RegExp(`${target.name}=${target.id}`, "u"));
  }
});

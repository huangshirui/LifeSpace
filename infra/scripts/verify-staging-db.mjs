import { executeStagingD1Sql } from "./staging-d1-retry.mjs";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVING_MODELS, STAGING_EXPECTATIONS } from "./staging-expectations.mjs";

const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const EXPECTED_MODELS = new Map(PROVING_MODELS.map((model) => [model.key, model]));

const REQUIRED_PLATFORM_TABLES = [
  "resource_records",
  "resource_relations",
  "mdl_task",
  "mdl_wish",
  "mdl_day_record",
  "mdl_event",
  "mdl_person_group",
  "mdl_anniversary",
  "mdl_activity",
  "mdl_goal",
  "mdl_person_profile",
  "mdl_habit",
  "temporal_occurrences",
  "model_definitions",
  "application_model_access",
  "model_contract_revisions",
  "model_contract_state",
  "model_definition_drafts",
  "space_person_names",
  "space_person_changes",
  "space_person_change_delegations",
];

const REQUIRED_TYPED_COLUMNS = new Map([
  ["mdl_task", ["record_id", "space_id", "completedAt", "completedById", "completedByType", "description", "dueDate", "name", "status"]],
  ["mdl_wish", ["record_id", "space_id", "description", "desiredDate", "fulfilledAt", "status", "title"]],
  ["mdl_day_record", ["record_id", "space_id", "anchorDate", "attentionAfterDays", "attentionBeforeDays", "cycleDays", "description", "kind", "name", "status"]],
  ["mdl_event", ["record_id", "space_id", "summary", "description", "__loc_location_name", "__loc_location_address", "__loc_location_latitude", "__loc_location_longitude", "__tr_when_kind", "__tr_when_start", "__tr_when_end", "status"]],
  ["mdl_person_group", ["record_id", "space_id", "name", "description"]],
  ["mdl_anniversary", ["record_id", "space_id", "name", "description", "month", "day", "year"]],
  ["mdl_activity", ["record_id", "space_id", "name", "description", "startDate", "endDate", "status"]],
  ["mdl_goal", ["record_id", "space_id", "name", "description", "startDate", "targetDate"]],
  ["mdl_person_profile", ["record_id", "space_id", "key", "value"]],
  ["mdl_habit", ["record_id", "space_id", "name", "description", "intervalDays", "lastCheckInDate", "streakStartDate"]],
]);

const FORBIDDEN_TYPED_COLUMNS = new Map([
  ["mdl_wish", ["archivedFromStatus", "claimedAt"]],
  ["mdl_event", ["location", "isAllDay", "startAt", "endAt", "startTimezone", "endTimezone", "startDate", "endDateExclusive"]],
]);

const MODEL_TABLES = new Map([
  ["task", "mdl_task"],
  ["wish", "mdl_wish"],
  ["day_record", "mdl_day_record"],
  ["event", "mdl_event"],
  ["person_group", "mdl_person_group"],
]);

const REQUIRED_TRIGGERS = [
  "finalize_claimed_ai_model_proposal_after_publication",
  "trg_space_people_advance_version",
  "trg_space_person_change_validate",
  "trg_space_person_change_delegation_consume_single_use",
];

const RETIRED_TABLES = [
  "resource_index_values",
  "events",
  "event_attendees",
  "tasks",
  "task_assignees",
  "day_records",
  "day_record_occurrences",
  "wishes",
];

function fail(message, detail) {
  if (detail !== undefined) console.error(detail);
  throw new Error(message);
}

// Only read-only verification SQL is passed here. Account-overload 7429
// can outlive a short retry; use the existing classifier with bounded backoff.
export async function runStagingVerificationSql(sql, options = {}) {
  const entries = await executeStagingD1Sql({ ...options, cwd: CORE_DIR, sql, attempts: 3, delayMs: 10000 });
  return decodeSqlRows(JSON.stringify(entries));
}

// Fail closed even if a successful integrity check would return no rows.
export function decodeSqlRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("Wrangler did not return JSON for the staging D1 verification query", stdout);
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (entry?.success === false) fail("Staging D1 query failed", entry);
  }
  for (const entry of entries) {
    if (Array.isArray(entry?.results)) return entry.results;
    if (Array.isArray(entry?.result?.results)) return entry.result.results;
  }
  fail("Wrangler did not return a staging D1 result array");
}

async function single(runSql, sql, label) {
  const rows = await runSql(sql);
  if (rows.length !== 1) fail(`${label}: expected exactly one row`, rows);
  return rows[0];
}

function assertEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) fail(`${label}: expected ${expected}, got ${actual}`);
}

function assertAtLeast(actual, minimum, label) {
  const numeric = Number(actual);
  if (!Number.isInteger(numeric) || numeric < minimum) {
    fail(`${label}: expected integer >= ${minimum}, got ${actual}`);
  }
}

function assertTruthy(value, label) {
  if (!value) fail(label);
}

// One sqlite_master inventory proves the same table and trigger checks.
export async function verifySchemaInventory(runSql) {
  const inventory = await runSql("SELECT type,name FROM sqlite_master WHERE type IN ('table','trigger')");
  const tableSet = new Set(inventory.filter(row => row.type === "table").map(row => row.name));
  const triggerSet = new Set(inventory.filter(row => row.type === "trigger").map(row => row.name));
  for (const table of REQUIRED_PLATFORM_TABLES) assertTruthy(tableSet.has(table), `Required platform table ${table} is missing`);
  for (const table of RETIRED_TABLES) if (tableSet.has(table)) fail(`Retired table ${table} still exists`);
  for (const name of REQUIRED_TRIGGERS) assertTruthy(triggerSet.has(name), `Required trigger ${name} is missing`);
}

export function orphanEnvelopeSql(modelKey) {
  const table = MODEL_TABLES.get(modelKey);
  if (!table) fail("Unsupported proving model for typed-envelope verification");
  // Keep all envelopes (including tombstones), the exact composite lookup,
  // and bounded ordered diagnostics; never sample or substitute counts.
  return `SELECT
      r.id,r.space_id,r.model_key,r.model_version,r.version,
      r.created_by_type,r.created_by_id,r.created_at,r.updated_at,r.deleted_at
    FROM resource_records r
    WHERE r.model_key='${modelKey}' AND NOT EXISTS(
      SELECT 1 FROM ${table} m WHERE m.record_id=r.id AND m.space_id=r.space_id
    )
    ORDER BY r.created_at,r.id
    LIMIT 20`;
}

export async function verifyTypedEnvelopes(runSql) {
  for (const modelKey of MODEL_TABLES.keys()) {
    const orphanEnvelopes = await runSql(orphanEnvelopeSql(modelKey));
    if (orphanEnvelopes.length) {
      fail(`${modelKey} resources without typed rows: expected 0, got at least ${orphanEnvelopes.length}`, orphanEnvelopes);
    }
  }
}

export async function verifyStagingDatabase(runSql, { requireActiveModelContract = false } = {}) {
  const schema = await single(runSql, "SELECT value FROM schema_metadata WHERE key='schema_version'", "schema_metadata");
  assertEqual(schema.value, STAGING_EXPECTATIONS.core.schemaVersion, "Core staging schema version");

  const modelRows = await runSql(`SELECT model_key,version,schema_hash,state
    FROM model_definitions WHERE state='published' ORDER BY model_key`);
  const actualModels = new Map(modelRows.map((row) => [row.model_key, row]));
  const verifiedModelVersions = {};
  for (const [key, expected] of EXPECTED_MODELS) {
    const row = actualModels.get(key);
    assertTruthy(row, `Published proving model ${key} is missing from staging Registry`);
    assertAtLeast(row.version, expected.minimumVersion, `${key} version`);
    assertEqual(row.schema_hash, expected.hash, `${key} schema hash`);
    verifiedModelVersions[key] = Number(row.version);
  }

  await verifySchemaInventory(runSql);

  const resourceColumns = new Set((await runSql("SELECT name FROM pragma_table_info('resource_records')")).map((row) => row.name));
  if (resourceColumns.has("data_json")) fail("Legacy resource_records.data_json column still exists");

  const personColumns = new Set((await runSql("SELECT name FROM pragma_table_info('space_people')")).map((row) => row.name));
  assertTruthy(personColumns.has("version"), "Space Person optimistic-concurrency version is missing");
  const personIndexes = new Set((await runSql("SELECT name FROM pragma_index_list('space_people')")).map((row) => row.name));
  assertTruthy(personIndexes.has("idx_space_people_lookup"), "Space Person lookup index is missing");
  const personNameIndexes = new Set((await runSql("SELECT name FROM pragma_index_list('space_person_names')")).map((row) => row.name));
  assertTruthy(personNameIndexes.has("idx_space_person_names_lookup"), "Space Person alternate-name lookup index is missing");

  for (const [table, expectedColumns] of REQUIRED_TYPED_COLUMNS) {
    const actualColumns = new Set((await runSql(`SELECT name FROM pragma_table_info('${table}')`)).map((row) => row.name));
    for (const column of expectedColumns) assertTruthy(actualColumns.has(column), `Typed model table ${table} is missing column ${column}`);
    for (const column of FORBIDDEN_TYPED_COLUMNS.get(table) ?? []) {
      if (actualColumns.has(column)) fail(`Typed model table ${table} still contains retired column ${column}`);
    }
  }

  await verifyTypedEnvelopes(runSql);

  const draftColumns = new Set((await runSql("SELECT name FROM pragma_table_info('model_definition_drafts')")).map((row) => row.name));
  for (const column of ["source", "proposal_status", "schema_hash", "diff_json", "recommended_compatibility", "publication_token", "publication_started_at", "published_model_id"]) {
    assertTruthy(draftColumns.has(column), `AI Model Admin proposal column ${column} is missing`);
  }

  const contractRows = await runSql(`SELECT s.active_contract_id,s.registry_revision,r.contract_hash
    FROM model_contract_state s JOIN model_contract_revisions r ON r.id=s.active_contract_id`);
  if (requireActiveModelContract) {
    if (contractRows.length !== 1) fail("Active Model Contract Revision has not been initialized", contractRows);
    const contract = contractRows[0];
    assertTruthy(/^mct_[a-f0-9]{64}$/u.test(contract.active_contract_id), "Active Model Contract ID is invalid");
    assertEqual(contract.contract_hash, contract.active_contract_id.slice(4), "Active Model Contract content hash");
    assertTruthy(Number(contract.registry_revision) >= 1, "Active Model Contract registry revision is invalid");
  } else if (contractRows.length > 1) {
    fail("Model Contract state contains multiple active rows", contractRows);
  }

  return {
    ok: true,
    schemaVersion: STAGING_EXPECTATIONS.core.schemaVersion,
    models: verifiedModelVersions,
    typedModelTables: [...REQUIRED_TYPED_COLUMNS.keys()],
    personDirectoryGovernedStorage: true,
    typedEnvelopeConsistency: true,
    legacyGenericStorageRemoved: true,
    activeModelContract: contractRows[0]?.active_contract_id ?? null,
    proposalAuditTrigger: true,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyStagingDatabase(runStagingVerificationSql, {
    requireActiveModelContract: process.env.REQUIRE_ACTIVE_MODEL_CONTRACT === "1",
  }), null, 2));
}

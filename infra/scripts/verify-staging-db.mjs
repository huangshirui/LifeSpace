import { execFileSync } from "node:child_process";
import process from "node:process";
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
  "temporal_occurrences",
  "model_definitions",
  "application_model_access",
  "model_contract_revisions",
  "model_contract_state",
  "model_definition_drafts",
];

const REQUIRED_TYPED_COLUMNS = new Map([
  ["mdl_task", ["record_id", "space_id", "completedAt", "completedById", "completedByType", "description", "dueDate", "name", "status"]],
  ["mdl_wish", ["record_id", "space_id", "description", "desiredDate", "fulfilledAt", "status", "title"]],
  ["mdl_day_record", ["record_id", "space_id", "anchorDate", "attentionAfterDays", "attentionBeforeDays", "cycleDays", "description", "icon", "kind", "name", "status"]],
  ["mdl_event", ["record_id", "space_id", "summary", "description", "location", "__tr_when_kind", "__tr_when_start", "__tr_when_end", "status"]],
]);

const FORBIDDEN_TYPED_COLUMNS = new Map([
  ["mdl_wish", ["archivedFromStatus", "claimedAt"]],
  ["mdl_event", ["isAllDay", "startAt", "endAt", "startTimezone", "endTimezone", "startDate", "endDateExclusive"]],
]);

const MODEL_TABLES = new Map([
  ["task", "mdl_task"],
  ["wish", "mdl_wish"],
  ["day_record", "mdl_day_record"],
  ["event", "mdl_event"],
]);

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

function runSql(sql) {
  const stdout = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--json", `--command=${sql}`],
    { cwd: CORE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: process.env },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail("Wrangler did not return JSON for the staging D1 verification query", stdout);
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (entry?.success === false) fail("Staging D1 query failed", entry);
    if (Array.isArray(entry?.results)) return entry.results;
    if (Array.isArray(entry?.result?.results)) return entry.result.results;
  }
  return [];
}

function single(sql, label) {
  const rows = runSql(sql);
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

const schema = single("SELECT value FROM schema_metadata WHERE key='schema_version'", "schema_metadata");
assertEqual(schema.value, STAGING_EXPECTATIONS.core.schemaVersion, "Core staging schema version");

const modelRows = runSql(`SELECT model_key,version,schema_hash,state
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


const tableSet = new Set(runSql("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
for (const table of REQUIRED_PLATFORM_TABLES) assertTruthy(tableSet.has(table), `Required platform table ${table} is missing`);
for (const table of RETIRED_TABLES) if (tableSet.has(table)) fail(`Retired table ${table} still exists`);

const resourceColumns = new Set(runSql("SELECT name FROM pragma_table_info('resource_records')").map((row) => row.name));
if (resourceColumns.has("data_json")) fail("Legacy resource_records.data_json column still exists");

for (const [table, expectedColumns] of REQUIRED_TYPED_COLUMNS) {
  const actualColumns = new Set(runSql(`SELECT name FROM pragma_table_info('${table}')`).map((row) => row.name));
  for (const column of expectedColumns) assertTruthy(actualColumns.has(column), `Typed model table ${table} is missing column ${column}`);
  for (const column of FORBIDDEN_TYPED_COLUMNS.get(table) ?? []) {
    if (actualColumns.has(column)) fail(`Typed model table ${table} still contains retired column ${column}`);
  }
}

for (const [modelKey, table] of MODEL_TABLES) {
  const orphanEnvelopes = runSql(`SELECT
      r.id,r.space_id,r.model_key,r.model_version,r.version,
      r.created_by_type,r.created_by_id,r.created_at,r.updated_at,r.deleted_at
    FROM resource_records r
    LEFT JOIN ${table} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE r.model_key='${modelKey}' AND m.record_id IS NULL
    ORDER BY r.created_at,r.id
    LIMIT 20`);
  if (orphanEnvelopes.length) {
    fail(`${modelKey} resources without typed rows: expected 0, got at least ${orphanEnvelopes.length}`, orphanEnvelopes);
  }
}

const draftColumns = new Set(runSql("SELECT name FROM pragma_table_info('model_definition_drafts')").map((row) => row.name));
for (const column of ["source", "proposal_status", "schema_hash", "diff_json", "recommended_compatibility", "publication_token", "publication_started_at", "published_model_id"]) {
  assertTruthy(draftColumns.has(column), `AI Model Admin proposal column ${column} is missing`);
}

const trigger = single(`SELECT name FROM sqlite_master
  WHERE type='trigger' AND name='finalize_claimed_ai_model_proposal_after_publication'`, "AI proposal audit trigger");
assertEqual(trigger.name, "finalize_claimed_ai_model_proposal_after_publication", "AI proposal audit trigger");

const contractRows = runSql(`SELECT s.active_contract_id,s.registry_revision,r.contract_hash
  FROM model_contract_state s JOIN model_contract_revisions r ON r.id=s.active_contract_id`);
if (process.env.REQUIRE_ACTIVE_MODEL_CONTRACT === "1") {
  if (contractRows.length !== 1) fail("Active Model Contract Revision has not been initialized", contractRows);
  const contract = contractRows[0];
  assertTruthy(/^mct_[a-f0-9]{64}$/u.test(contract.active_contract_id), "Active Model Contract ID is invalid");
  assertEqual(contract.contract_hash, contract.active_contract_id.slice(4), "Active Model Contract content hash");
  assertTruthy(Number(contract.registry_revision) >= 1, "Active Model Contract registry revision is invalid");
} else if (contractRows.length > 1) {
  fail("Model Contract state contains multiple active rows", contractRows);
}

console.log(JSON.stringify({
  ok: true,
  schemaVersion: STAGING_EXPECTATIONS.core.schemaVersion,
  models: verifiedModelVersions,
  typedModelTables: [...REQUIRED_TYPED_COLUMNS.keys()],
  typedEnvelopeConsistency: true,
  legacyGenericStorageRemoved: true,
  activeModelContract: contractRows[0]?.active_contract_id ?? null,
  proposalAuditTrigger: true,
}, null, 2));

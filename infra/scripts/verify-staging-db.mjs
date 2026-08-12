import { execFileSync } from "node:child_process";
import process from "node:process";
import { PROVING_MODELS, STAGING_EXPECTATIONS } from "./staging-expectations.mjs";

const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const EXPECTED_MODELS = new Map(PROVING_MODELS.map((model) => [model.key, model]));

const REQUIRED_PLATFORM_TABLES = [
  "resource_records",
  "resource_relations",
  "resource_index_values",
  "temporal_occurrences",
  "model_definitions",
  "application_model_access",
  "model_contract_revisions",
  "model_contract_state",
  "model_definition_drafts",
];

const RETIRED_DOMAIN_TABLES = [
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

function assertTruthy(value, label) {
  if (!value) fail(label);
}

const schema = single("SELECT value FROM schema_metadata WHERE key='schema_version'", "schema_metadata");
assertEqual(schema.value, STAGING_EXPECTATIONS.core.schemaVersion, "Core staging schema version");

const modelRows = runSql(`SELECT model_key,route_segment,version,schema_hash,state
  FROM model_definitions WHERE state='published' ORDER BY model_key`);
const actualModels = new Map(modelRows.map((row) => [row.model_key, row]));
for (const [key, expected] of EXPECTED_MODELS) {
  const row = actualModels.get(key);
  assertTruthy(row, `Published proving model ${key} is missing from staging Registry`);
  assertEqual(row.route_segment, expected.route, `${key} route`);
  assertEqual(row.version, expected.version, `${key} version`);
  assertEqual(row.schema_hash, expected.hash, `${key} schema hash`);
}

const accessRows = runSql(`SELECT model_key,max_access
  FROM application_model_access
  WHERE application_id='homemew-miniprogram'
    AND model_key IN ('task','wish','day_record','event')
  ORDER BY model_key`);
const access = new Map(accessRows.map((row) => [row.model_key, row.max_access]));
for (const key of EXPECTED_MODELS.keys()) assertEqual(access.get(key), "write", `homemew-miniprogram ${key} model access`);

const tableSet = new Set(runSql("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
for (const table of REQUIRED_PLATFORM_TABLES) assertTruthy(tableSet.has(table), `Required platform table ${table} is missing`);
for (const table of RETIRED_DOMAIN_TABLES) if (tableSet.has(table)) fail(`Retired Phase-2 domain table ${table} still exists`);

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
  models: Object.fromEntries(PROVING_MODELS.map((model) => [model.key, model.version])),
  homemewModelAccess: "write",
  activeModelContract: contractRows[0]?.active_contract_id ?? null,
  proposalAuditTrigger: true,
}, null, 2));

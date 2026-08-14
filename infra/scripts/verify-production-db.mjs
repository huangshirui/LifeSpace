import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { PRODUCTION_EXPECTATIONS, PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";

const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));
const productionApplicationId = profile.application.productionId;

const REQUIRED_PLATFORM_TABLES = [
  "spaces",
  "space_memberships",
  "space_people",
  "space_invites",
  "data_grants",
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

function runSql(cwd, sql) {
  const stdout = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "production", "--json", `--command=${sql}`],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: process.env },
  );
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch { fail("Wrangler did not return JSON for production D1 verification", stdout); }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (entry?.success === false) fail("Production D1 query failed", entry);
    if (Array.isArray(entry?.results)) return entry.results;
    if (Array.isArray(entry?.result?.results)) return entry.result.results;
  }
  return [];
}

const coreSql = (sql) => runSql(CORE_DIR, sql);
const identitySql = (sql) => runSql(IDENTITY_DIR, sql);

function single(rows, label) {
  if (rows.length !== 1) fail(`${label}: expected exactly one row`, rows);
  return rows[0];
}
function assertEqual(actual, expected, label) {
  if (String(actual) !== String(expected)) fail(`${label}: expected ${expected}, got ${actual}`);
}
function assertZeroCount(rows, label) {
  const row = single(rows, label);
  if (Number(row.count) !== 0) fail(`${label}: expected 0, got ${row.count}`);
}

assertEqual(single(coreSql("SELECT value FROM schema_metadata WHERE key='schema_version'"), "Core schema").value, PRODUCTION_EXPECTATIONS.core.schemaVersion, "Core production schema version");
assertEqual(single(identitySql("SELECT value FROM schema_metadata WHERE key='schema_version'"), "Identity schema").value, PRODUCTION_EXPECTATIONS.identity.schemaVersion, "Identity production schema version");

const published = new Map(coreSql(`SELECT model_key,route_segment,version,schema_hash,state FROM model_definitions WHERE state='published'`).map((row) => [row.model_key, row]));
for (const expected of PRODUCTION_PROVING_MODELS) {
  const actual = published.get(expected.key);
  if (!actual) fail(`Published production model ${expected.key} is missing`);
  assertEqual(actual.route_segment, expected.route, `${expected.key} route`);
  assertEqual(actual.version, expected.version, `${expected.key} version`);
  assertEqual(actual.schema_hash, expected.hash, `${expected.key} schema hash`);
}

const accessRows = coreSql(`SELECT model_key,max_access FROM application_model_access
  WHERE application_id='${productionApplicationId.replaceAll("'", "''")}'
    AND model_key IN ('task','wish','day_record','event') ORDER BY model_key`);
const access = new Map(accessRows.map((row) => [row.model_key, row.max_access]));
for (const expected of PRODUCTION_PROVING_MODELS) assertEqual(access.get(expected.key), "write", `${productionApplicationId} ${expected.key} access`);

const contract = single(coreSql(`SELECT s.active_contract_id,s.registry_revision,r.contract_hash
  FROM model_contract_state s JOIN model_contract_revisions r ON r.id=s.active_contract_id
  WHERE s.singleton=1`), "Active production Model Contract");
assertEqual(contract.active_contract_id, profile.contracts.modelContract, "Accepted production Model Contract");
assertEqual(contract.contract_hash, profile.contracts.modelContract.slice(4), "Production Model Contract content hash");
if (Number(contract.registry_revision) < 1) fail("Production Model Contract registry revision is invalid");

const tableSet = new Set(coreSql("SELECT name FROM sqlite_master WHERE type='table'").map((row) => row.name));
for (const table of REQUIRED_PLATFORM_TABLES) if (!tableSet.has(table)) fail(`Required production platform table ${table} is missing`);
for (const table of RETIRED_TABLES) if (tableSet.has(table)) fail(`Retired production table ${table} still exists`);

// Phase 6 is explicitly an empty-platform bring-up. These checks are intentionally
// stricter than the long-lived production deploy gate and are only invoked when
// phase6_bringup=true; normal production deploys do not run them after Phase 7 starts.
for (const [table, label] of [
  ["spaces", "Core spaces"],
  ["space_memberships", "Core memberships"],
  ["space_people", "Core space people"],
  ["space_invites", "Core space invites"],
  ["data_grants", "Core data grants"],
  ["resource_records", "Core business resources"],
  ["resource_relations", "Core resource relations"],
  ["temporal_occurrences", "Core temporal occurrences"],
]) {
  assertZeroCount(coreSql(`SELECT COUNT(*) count FROM ${table}`), label);
}
assertZeroCount(identitySql("SELECT COUNT(*) count FROM users"), "Identity users");
assertZeroCount(identitySql("SELECT COUNT(*) count FROM service_principals"), "Identity service principals");
assertZeroCount(identitySql("SELECT COUNT(*) count FROM service_api_tokens"), "Identity service API tokens");
assertZeroCount(identitySql("SELECT COUNT(*) count FROM service_oauth_credentials"), "Identity OAuth credentials");

const application = single(identitySql(`SELECT id,client_type,allowed_scopes,trusted_backend,access_token_ttl_seconds,status
  FROM applications WHERE id='${productionApplicationId.replaceAll("'", "''")}'`), "HomeMew production application");
assertEqual(application.client_type, profile.application.clientType, "HomeMew production client type");
assertEqual(application.trusted_backend, 1, "HomeMew production trusted backend flag");
assertEqual(application.access_token_ttl_seconds, profile.application.accessTokenTtlSeconds, "HomeMew production token TTL");
assertEqual(application.status, "active", "HomeMew production application status");
const storedScopes = JSON.parse(application.allowed_scopes);
const expectedScopes = profile.application.allowedUserScopes;
if (!Array.isArray(storedScopes) || storedScopes.length !== expectedScopes.length || !storedScopes.every((scope) => expectedScopes.includes(scope))) {
  fail("HomeMew production allowed scopes do not match the accepted integration profile", storedScopes);
}
assertZeroCount(identitySql(`SELECT COUNT(*) count FROM application_credentials
  WHERE application_id='${productionApplicationId.replaceAll("'", "''")}' AND status='active' AND revoked_at IS NULL`), "Active HomeMew production application credentials");
assertZeroCount(identitySql("SELECT COUNT(*) count FROM applications WHERE id LIKE 'app_production_%_probe_%'"), "Residual Phase 6 probe applications");

console.log(JSON.stringify({
  ok: true,
  coreSchemaVersion: PRODUCTION_EXPECTATIONS.core.schemaVersion,
  identitySchemaVersion: PRODUCTION_EXPECTATIONS.identity.schemaVersion,
  activeModelContract: contract.active_contract_id,
  homemewApplicationId: productionApplicationId,
  homemewActiveCredentials: 0,
  businessState: "empty",
  probeAuthorityResiduals: 0,
}, null, 2));

// Pre-schema-71 convergence for the one reviewed, manually published Goal snapshot.
// Historical migrations 0071/0072 remain immutable. Never infer compatibility from
// modelKey alone and never replace business records or an unrecognized definition.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const LEGACY_GOAL_HASH = "c5e412c0b7391a2d5d3cf3bf31d8563fab7d579f6882c3045331638874ae4d7b";

// Reviewed staging Goal v1. Only prose descriptions differ from the schema-71
// baseline; field constraints, relations, query, access, and lifecycle match.
export const LEGACY_GOAL_SEMANTICS = {
  access: ["read", "write"],
  definitionVersion: 1,
  display: { plural: "Goals", singular: "Goal" },
  fields: {
    description: { maxLength: 5000, nullable: true, type: "text" },
    name: { maxLength: 150, minLength: 1, required: true, type: "string" },
    startDate: { nullable: true, type: "date" },
    subjectPersonIds: { type: "person_list" },
    targetDate: { nullable: true, type: "date" },
  },
  key: "goal",
  lifecycle: { optimisticConcurrency: true, softDelete: true },
  query: {
    filterable: ["subjectPersonIds", "startDate", "targetDate"],
    searchable: ["name", "description"],
    sortable: ["targetDate", "name"],
  },
  referenceLabel: { field: "name" },
  semanticRelations: { outgoing: ["relates_to"] },
};

function removeDocumentation(value) {
  if (Array.isArray(value)) return value.map(removeDocumentation);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description" && key !== "title")
    .map(([key, entry]) => [key, removeDocumentation(entry)]));
}

// Top-level model description and field descriptions are presentation-only;
// never drop a field/type/query/authority/lifecycle property from the comparison.
export function reviewedGoalSemantics(definition) {
  const { description: _description, ...withoutProse } = definition;
  return {
    ...withoutProse,
    fields: Object.fromEntries(Object.entries(definition.fields ?? {})
      .map(([key, field]) => [key, removeDocumentation(field)])),
  };
}

export function convergeLegacyGoalBeforeSchema71(runSql) {
  const schema = runSql("SELECT value FROM schema_metadata WHERE key='schema_version'");
  if (schema.length !== 1 || !Number.isSafeInteger(Number(schema[0].value))) {
    throw new Error("Unable to verify Core schema version before migration");
  }
  const version = Number(schema[0].value);
  if (version >= 71) return { result: "already-at-schema-71-or-newer", schemaVersion: version };

  const published = runSql(
    "SELECT id,version,route_segment,schema_hash,definition_json FROM model_definitions "
    + "WHERE model_key='goal' AND state='published'",
  );
  if (!published.length) return { result: "no-published-legacy-goal", schemaVersion: version };

  if (version !== 70 || published.length !== 1) {
    throw new Error("Unexpected published Goal before schema 71; refusing automatic migration");
  }
  const goal = published[0];
  if (goal.schema_hash !== LEGACY_GOAL_HASH || Number(goal.version) !== 1 || goal.route_segment !== "goal") {
    throw new Error("Unknown pre-schema-71 Goal snapshot; review the Model Definition before migration");
  }
  let definition;
  try {
    definition = JSON.parse(goal.definition_json);
  } catch {
    throw new Error("Existing Goal definition is not valid JSON; refusing migration");
  }
  assert.deepStrictEqual(
    reviewedGoalSemantics(definition),
    LEGACY_GOAL_SEMANTICS,
    "The existing Goal semantics differ from the reviewed historical snapshot",
  );

  const records = runSql("SELECT COUNT(*) AS count FROM resource_records WHERE model_key='goal'");
  if (records.length !== 1 || !Number.isSafeInteger(Number(records[0].count)) || Number(records[0].count) !== 0) {
    throw new Error("Goal business records exist or cannot be verified; owner-reviewed migration required");
  }

  // Same-statement predicates guard against intervening writes. In particular
  // do not supersede an altered hash or owner data published after the read.
  const updated = runSql(
    "UPDATE model_definitions SET state='superseded',"
    + "superseded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') "
    + "WHERE model_key='goal' AND version=1 AND route_segment='goal' "
    + "AND state='published' AND schema_hash='" + LEGACY_GOAL_HASH + "' "
    + "AND EXISTS(SELECT 1 FROM schema_metadata WHERE key='schema_version' AND value='70') "
    + "AND NOT EXISTS(SELECT 1 FROM resource_records WHERE model_key='goal') "
    + "RETURNING id,state",
  );
  if (updated.length !== 1 || updated[0].id !== goal.id || updated[0].state !== "superseded") {
    throw new Error("Legacy Goal convergence did not atomically update the expected definition");
  }
  return { result: "reviewed-goal-superseded-before-schema-71", schemaVersion: version };
}

function wranglerQuery(environment, sql) {
  const cwd = fileURLToPath(new URL("../../apps/core/", import.meta.url));
  const stdout = execFileSync("pnpm", [
    "exec", "wrangler", "d1", "execute", "DB", "--remote",
    "--env", environment, "--json", "--command=" + sql,
  ], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const payload = JSON.parse(stdout);
  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length !== 1 || entries[0]?.success !== true || !Array.isArray(entries[0]?.results)) {
    throw new Error("Unexpected Wrangler D1 query result before schema 71");
  }
  return entries[0].results;
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  const environment = process.argv[2];
  if (environment !== "staging" && environment !== "production") {
    throw new Error("Usage: node converge-legacy-goal-before-71.mjs <staging|production>");
  }
  const outcome = convergeLegacyGoalBeforeSchema71((sql) => wranglerQuery(environment, sql));
  console.log(JSON.stringify({ environment, ...outcome }));
}

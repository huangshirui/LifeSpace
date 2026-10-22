import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  convergeLegacyGoalBeforeSchema71,
  LEGACY_GOAL_HASH,
  LEGACY_GOAL_SEMANTICS,
  reviewedGoalSemantics,
} from "./converge-legacy-goal-before-71.mjs";

const previousDefinition = () => ({
  description: "Old Goal model summary",
  ...structuredClone(LEGACY_GOAL_SEMANTICS),
  fields: Object.fromEntries(Object.entries(LEGACY_GOAL_SEMANTICS.fields)
    .map(([name, field]) => [name, {
      title: name,
      description: "A documentation-only description of " + name,
      ...field,
    }])),
});

function fixture({ schemaVersion = 70, publishedGoal = true, hash = LEGACY_GOAL_HASH,
  definition = previousDefinition(), goalRecords = 0, updateRows = null } = {}) {
  const current = { published: publishedGoal, hash, definition };
  const statements = [];
  const runSql = (sql) => {
    statements.push(sql);
    if (sql.startsWith("UPDATE model_definitions")) {
      if (updateRows !== null) return updateRows;
      if (schemaVersion !== 70 || goalRecords !== 0 || current.hash !== LEGACY_GOAL_HASH) return [];
      current.published = false;
      return [{ id: "mdl_prior_goal_v1", state: "superseded" }];
    }
    if (sql.includes("FROM schema_metadata")) return [{ value: String(schemaVersion) }];
    if (sql.includes("FROM model_definitions")) return current.published ? [{
      id: "mdl_prior_goal_v1",
      version: 1,
      route_segment: "goal",
      schema_hash: current.hash,
      definition_json: JSON.stringify(current.definition),
    }] : [];
    if (sql.includes("FROM resource_records")) return [{ count: goalRecords }];
    throw new Error("Unexpected SQL: " + sql);
  };
  return { runSql, statements, current };
}

test("the verified historical Goal only differs by prose and field labels", () => {
  assert.deepStrictEqual(reviewedGoalSemantics(previousDefinition()), LEGACY_GOAL_SEMANTICS);
  const modified = previousDefinition();
  modified.fields.subjectPersonIds.required = true;
  assert.notDeepStrictEqual(reviewedGoalSemantics(modified), LEGACY_GOAL_SEMANTICS);
});

test("only the reviewed zero-record Goal v1 is superseded before migration 0071", () => {
  const f = fixture();
  assert.deepStrictEqual(convergeLegacyGoalBeforeSchema71(f.runSql), {
    result: "reviewed-goal-superseded-before-schema-71",
    schemaVersion: 70,
  });
  assert.equal(f.current.published, false);
  assert.equal(f.statements.filter((s) => s.startsWith("UPDATE")).length, 1);
  assert.match(f.statements.at(-1), /NOT EXISTS\(SELECT 1 FROM resource_records WHERE model_key='goal'\)/u);
  assert.match(f.statements.at(-1), /schema_version' AND value='70'/u);
  // The migration was interrupted after preflight: the next run is safe to retry.
  assert.equal(convergeLegacyGoalBeforeSchema71(f.runSql).result, "no-published-legacy-goal");
});

test("does nothing on a normal first publication or already-applied schema", () => {
  for (const options of [
    { schemaVersion: 53, publishedGoal: false },
    { schemaVersion: 70, publishedGoal: false },
    { schemaVersion: 71 },
    { schemaVersion: 72 },
  ]) {
    const f = fixture(options);
    convergeLegacyGoalBeforeSchema71(f.runSql);
    assert.equal(f.statements.filter((s) => s.startsWith("UPDATE")).length, 0);
  }
});

test("unknown Goal publication fails closed before mutation", () => {
  const f = fixture({ hash: "unknown-manual-published-model" });
  assert.throws(() => convergeLegacyGoalBeforeSchema71(f.runSql), /Unknown pre-schema-71 Goal snapshot/u);
  assert.equal(f.statements.some((s) => s.startsWith("UPDATE")), false);
});

test("old Goal with business records fails closed and retains its publication", () => {
  const f = fixture({ goalRecords: 1 });
  assert.throws(() => convergeLegacyGoalBeforeSchema71(f.runSql), /Goal business records exist/u);
  assert.equal(f.current.published, true);
  assert.equal(f.statements.some((s) => s.startsWith("UPDATE")), false);
});

test("unrecognized legacy shape fails closed even if the hash is whitelisted", () => {
  const definition = previousDefinition();
  definition.fields.intervalDays = { type: "integer" };
  const f = fixture({ definition });
  assert.throws(() => convergeLegacyGoalBeforeSchema71(f.runSql), /historical snapshot/u);
  assert.equal(f.statements.some((s) => s.startsWith("UPDATE")), false);
});

test("pre-schema-70 publication is not silently altered", () => {
  const f = fixture({ schemaVersion: 53 });
  assert.throws(() => convergeLegacyGoalBeforeSchema71(f.runSql), /Unexpected published Goal before schema 71/u);
  assert.equal(f.statements.some((s) => s.startsWith("UPDATE")), false);
});

test("no successful matched row means the convergence fails", () => {
  const f = fixture({ updateRows: [] });
  assert.throws(() => convergeLegacyGoalBeforeSchema71(f.runSql), /did not atomically update/u);
});

test("staging and production migration commands both run guarded convergence", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../apps/core/package.json", import.meta.url)));
  for (const env of ["staging", "production"]) {
    assert.match(pkg.scripts["db:migrate:" + env], new RegExp("converge-legacy-goal-before-71\\.mjs " + env));
    assert.match(pkg.scripts["db:migrate:" + env], /&& wrangler d1 migrations apply DB --remote/u);
  }
  const migration = readFileSync(new URL("../../apps/core/migrations/0071_baseline_domain_models.sql", import.meta.url), "utf8");
  assert.match(migration, /mdl_catalog_goal_20261021/u);
});

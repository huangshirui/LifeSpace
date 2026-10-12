import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../migrations/0054_semantic_relations.sql", import.meta.url), "utf8");

test("schema 54 keeps Semantic Relation independent from fixed field relation projections", () => {
  assert.match(source, /CREATE TABLE semantic_relations/u);
  assert.match(source, /UNIQUE\(space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id\)/u);
  assert.doesNotMatch(source, /field_key/u);
});

test("schema 54 provides bounded indexed traversal paths", () => {
  assert.match(source, /idx_semantic_relations_source[\s\S]*space_id,source_model_key,source_record_id,predicate,created_at DESC,id DESC/u);
  assert.match(source, /idx_semantic_relations_target[\s\S]*space_id,target_model_key,target_record_id,predicate,created_at DESC,id DESC/u);
  assert.match(source, /idx_semantic_relations_predicate[\s\S]*space_id,predicate,created_at DESC,id DESC/u);
});

test("schema 54 preserves relation Change evidence and atomically cleans edges on endpoint delete", () => {
  assert.match(source, /CREATE TABLE semantic_relation_changes/u);
  assert.match(source, /operation TEXT NOT NULL CHECK\(operation IN \('create','delete','endpoint_delete'\)\)/u);
  assert.match(source, /CREATE TRIGGER trg_semantic_relations_cleanup_on_record_delete/u);
  assert.match(source, /AFTER INSERT ON resource_changes/u);
  assert.match(source, /WHEN NEW\.operation='delete'/u);
  assert.match(source, /DELETE FROM semantic_relations[\s\S]*source_record_id=NEW\.record_id/u);
  assert.match(source, /DELETE FROM semantic_relations[\s\S]*target_record_id=NEW\.record_id/u);
});

test("schema 54 keeps single-use Delegation consumption atomic for relation mutations", () => {
  assert.match(source, /CREATE TABLE semantic_relation_change_delegations/u);
  assert.match(source, /CREATE TRIGGER trg_semantic_relation_change_delegation_consume_single_use/u);
  assert.match(source, /DELEGATION_SINGLE_USE_UNAVAILABLE/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const migration = new URL("../migrations/0049_authorization_requests.sql", import.meta.url);
const source = readFileSync(fileURLToPath(migration), "utf8");

test("schema 49 adds Authorization Request state without rebuilding existing authority tables", () => {
  assert.match(source, /CREATE\s+TABLE\s+authorization_requests/iu);
  assert.match(source, /CREATE\s+TABLE\s+authorization_request_review_tokens/iu);
  assert.match(source, /CREATE\s+TABLE\s+authorization_request_delegations/iu);
  assert.match(source, /CREATE\s+UNIQUE\s+INDEX\s+idx_authorization_requests_pending_dedupe/iu);
  assert.match(source, /AUTH_REQUEST_NOT_PENDING/u);
  assert.match(source, /AUTH_REQUEST_APPROVAL_INCOMPLETE/u);
  assert.doesNotMatch(source, /DROP\s+TABLE\s+(delegations|delegation_scopes|resource_records|spaces)/iu);
  assert.doesNotMatch(source, /ALTER\s+TABLE\s+(delegations|delegation_scopes|resource_records|spaces)/iu);
  assert.match(source, /UPDATE\s+schema_metadata\s+SET\s+value='49'/iu);
});

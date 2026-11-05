import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectAccessApplication, inspectStrictPolicy, inspectStatus,
} from "../scripts/check-staging-readiness.mjs";

test("Account Access readiness rejects absent, duplicate and wrong-domain protection", () => {
  const correct = {
    id: "uuid-account", type: "self_hosted", name: "LifeSpace Account Staging",
    domain: "account-staging.aisr.online", aud: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
  };
  assert.equal(inspectAccessApplication([]).code, "ACCOUNT_ACCESS_MISSING");
  assert.equal(inspectAccessApplication([correct, correct]).code, "DUPLICATE_ACCESS_APPLICATION");
  assert.equal(inspectAccessApplication([{ ...correct, type: "saas" }]).code, "ACCOUNT_ACCESS_INVALID");
  assert.equal(inspectAccessApplication([correct]).ok, true);
  assert.equal(inspectAccessApplication([{ ...correct, domain: "account.aisr.online" }]).ok, false);
});

test("only tightly scoped exact-email human Access allow rules satisfy the Staging gate", () => {
  const owner = { decision: "allow", include: [{ email: { email: "owner@example.test" } }] };
  assert.equal(inspectStrictPolicy([owner]).ok, true);
  assert.equal(inspectStrictPolicy([]).code, "ACCOUNT_POLICY_MISSING");
  for (const rule of [
    { everyone: {} }, { email_domain: { domain: "example.test" } },
    { any_valid_service_token: {} }, { group: { id: "group1" } },
    { email: { email: "*" } },
  ]) {
    assert.equal(inspectStrictPolicy([{ decision: "allow", include: [rule] }]).ok, false);
  }
  assert.equal(inspectStrictPolicy([{ decision: "allow", include: [owner.include[0], { everyone: {} }] }]).ok, false);
});

test("Identity and Core must both match candidate schema and contracts exactly", () => {
  const expected = { contractVersion: "0.18.0", schemaVersion: 15 };
  const live = { environment: "staging", contractVersion: "0.18.0", schemaVersion: "15" };
  assert.equal(inspectStatus(live, expected, "identity").ok, true);
  assert.equal(inspectStatus({ ...live, environment: "production" }, expected, "identity").ok, false);
  assert.equal(inspectStatus({ ...live, schemaVersion: "14" }, expected, "identity").ok, false);
  assert.equal(inspectStatus({ ...live, contractVersion: "0.17.0" }, expected, "identity").ok, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inspectAccessApplication, inspectStrictPolicy, inspectStatus, runStagingOAuthReadiness,
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
  assert.equal(inspectStrictPolicy([]).code, "ACCOUNT_POLICY_NOT_STRICT_OWNER_EMAIL");
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

test("full Account staging readiness checks remote services but cannot claim private authority readiness", async () => {
  const { STAGING_EXPECTATIONS } = await import("../../../infra/scripts/staging-expectations.mjs");
  const access = {
    id: "staging-access", type: "self_hosted", name: "LifeSpace Account Staging",
    domain: "account-staging.aisr.online", aud: "abcdef0123456789".repeat(4),
  };
  const calls = [];
  const result = await runStagingOAuthReadiness({
    env: { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: "read-only-test" },
    fetcher: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET" });
      assert.notEqual(init?.method, "POST");
      if (url.endsWith("/access/apps?per_page=100")) {
        return Response.json({ success: true, result: [access] });
      }
      if (url.includes("/access/apps/staging-access/policies")) {
        return Response.json({ success: true, result: [{
          name: "Only Me", decision: "allow", precedence: 1,
          include: [{ email: { email: "owner@example.test" } }],
        }] });
      }
      if (url.endsWith("/workers/scripts")) {
        return Response.json({ success: true, result: [{ id: "lifespace-account-staging" }] });
      }
      if (url.includes("auth-staging.aisr.online")) {
        return Response.json({ data: { environment: "staging", ...STAGING_EXPECTATIONS.identity } });
      }
      if (url.includes("core-staging.aisr.online")) {
        return Response.json({ data: { environment: "staging", ...STAGING_EXPECTATIONS.core } });
      }
      throw new Error("Unexpected URL " + url);
    },
  });
  assert.equal(calls.length, 5);
  assert.equal(calls.every((call) => call.method === "GET"), true);
  assert.equal(result.mutation, false);
  assert.equal(result.checks.access.ok, true);
  assert.equal(result.checks.policy.ok, true);
  assert.equal(result.checks.worker.ok, true);
  assert.equal(result.checks.identity.ok, true);
  assert.equal(result.checks.core.ok, true);
  assert.equal(result.checks.identityAccessBinding.ok, false);
  assert.equal(result.checks.secrets.ok, false);
  assert.equal(result.ok, false);
});

test("readiness gate fails closed before any request when Cloudflare credentials are missing", async () => {
  let requested = false;
  const result = await runStagingOAuthReadiness({
    env: { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" },
    fetcher: async () => { requested = true; throw new Error("must never call"); },
  });
  assert.equal(requested, false);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ["CLOUDFLARE_CREDENTIALS_NOT_CONFIGURED"]);
});

test("Access readiness rejects mixed or invalid owner-email policies, matching provisioner", () => {
  const exact = { decision: "allow", include: [{ email: { email: "owner@example.test" } }] };
  assert.equal(inspectStrictPolicy([exact, { decision: "deny", include: [{ everyone: {} }] }]).ok, false);
  assert.equal(inspectStrictPolicy([{
    decision: "allow", include: [{ email: { email: "owner@example.test" }, group: { id: "any" } }],
  }]).ok, false);
});

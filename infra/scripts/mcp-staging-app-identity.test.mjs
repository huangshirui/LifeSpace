import assert from "node:assert/strict";
import test from "node:test";
import { verifyMcpStagingApplication } from "./mcp-staging-app-identity.mjs";

const approved = Object.freeze({
  id: "app_1234_staging_mcp",
  name: "LifeSpace MCP Staging",
  status: "active",
  trustedBackend: true,
  accessTokenTtlSeconds: 600,
  allowedScopes: ["resources:read"],
});

test("Identity self-inspection is sufficient when GitHub ID variable is absent", () => {
  assert.deepEqual(verifyMcpStagingApplication(approved, ""), { idSource: "identity_self_verified" });
});

test("matching optional configured ID is checked independently", () => {
  assert.deepEqual(verifyMcpStagingApplication(approved, approved.id), { idSource: "configured_and_self_verified" });
  assert.throws(() => verifyMcpStagingApplication(approved, "app_other"), /does not match/u);
  assert.throws(() => verifyMcpStagingApplication(approved, "not an app"), /malformed/u);
});

test("untrusted or wrong-purpose credentials fail closed regardless of optional ID", () => {
  for (const update of [
    { id: "not_a_valid_id" },
    { name: "HomeMew Staging" },
    { status: "disabled" },
    { trustedBackend: false },
    { accessTokenTtlSeconds: 3600 },
    { allowedScopes: ["resources:read", "resources:write"] },
    { allowedScopes: ["resources:write"] },
  ]) {
    assert.throws(() => verifyMcpStagingApplication({ ...approved, ...update }), Error);
  }
  assert.throws(() => verifyMcpStagingApplication(null), Error);
});

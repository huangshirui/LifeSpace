import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = new URL("../../../infra/scripts/verify-staging-authority-v3.mjs", import.meta.url);
const workflow = new URL("../../../.github/workflows/staging-deploy.yml", import.meta.url);

test("Authority v3 staging verifier remains syntax-valid, staging-only and bounded", () => {
  const filename = fileURLToPath(verifier);
  const syntax = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${filename} failed node --check: ${syntax.stderr || syntax.stdout}`);

  const source = readFileSync(filename, "utf8");
  assert.match(source, /core-staging\.aisr\.online/u);
  assert.match(source, /auth-staging\.aisr\.online/u);
  assert.doesNotMatch(source, /core\.aisr\.online/u);
  assert.doesNotMatch(source, /auth\.aisr\.online/u);
  assert.match(source, /scopes:\s*\["resources:read", "resources:write"\]/u, "Agent smoke credential must stay resource-scoped");
  assert.match(source, /profileProbe\.response\.status !== 403/u, "Agent smoke must verify profile access is denied without profile:read");
  assert.match(source, /Direct Agent profile scope boundary was not enforced/u, "least-privilege profile denial must be a release assertion");
  assert.match(source, /granteeType:\s*"agent"/u, "staging must exercise Agent-owned Data Grant authority");
  assert.match(source, /principalType:\s*"user"/u, "staging must exercise represented User Principal execution");
  assert.match(source, /remainingRedelegationDepth:\s*1/u, "Root Delegation must explicitly permit one child hop");
  assert.match(source, /remainingRedelegationDepth:\s*0/u, "Child Delegation must exhaust re-delegation depth");
  assert.match(source, /parentDelegationId:\s*rootDelegationId/u, "Child issuance must bind the explicit parent");
  assert.match(source, /Child Delegation remained usable after Root revoke/u, "ancestor revocation must be verified fail-closed");
  assert.match(source, /15 \* 60 \* 1000/u, "temporary Agent authority must be bounded to at most 15 minutes");
  assert.match(source, /finally \{/u, "temporary Agent authority must be cleaned even on smoke failure");
});

test("staging deployment executes Authority v3 verification before cleanup", () => {
  const source = readFileSync(fileURLToPath(workflow), "utf8");
  const syntaxCheckIndex = source.indexOf("node --check infra/scripts/verify-staging-authority-v3.mjs");
  const verifyIndex = source.indexOf("- name: Verify Agent Principal and bounded re-delegation");
  const cleanupIndex = source.indexOf("- name: Cleanup ephemeral staging authority");

  assert.notEqual(syntaxCheckIndex, -1, "staging deploy must syntax-check the Authority v3 verifier");
  assert.notEqual(verifyIndex, -1, "staging deploy must execute the Authority v3 verifier");
  assert.notEqual(cleanupIndex, -1, "staging deploy must retain ephemeral authority cleanup");
  assert.ok(verifyIndex < cleanupIndex, "Authority v3 verification must complete before ephemeral authority cleanup");
});

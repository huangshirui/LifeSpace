import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const profile = JSON.parse(fs.readFileSync(new URL("../aloha-integration-profile.json", import.meta.url), "utf8"));
const verifier = fs.readFileSync(new URL("./verify-staging-aloha-m4-read.mjs", import.meta.url), "utf8");
const workflow = fs.readFileSync(new URL("../../.github/workflows/staging-deploy.yml", import.meta.url), "utf8");

test("ALOHA M4 integration profile is explicitly Task read-only", () => {
  assert.equal(profile.profileVersion, 2);
  assert.equal(profile.trackingIssue, 162);
  assert.equal(profile.status, "candidate");
  assert.equal(profile.application.key, "aloha-assistant");
  assert.equal(profile.application.clientType, "web");
  assert.equal(profile.application.trustedBackend, true);
  assert.equal(profile.application.accessTokenTtlSeconds, 900);
  assert.deepEqual(profile.application.allowedUserScopes, ["profile:read", "resources:read"]);
  assert.doesNotMatch(profile.application.stagingId, /m4/iu, "Application identity must remain milestone-neutral");
  assert.deepEqual(profile.agentIdentity.m4RequestedScopes, ["resources:read"]);
  assert.deepEqual(profile.coreAuthority.m4ModelAccess, { task: "read" });
  assert.equal(profile.coreAuthority.m4DelegationRequired, true);
  assert.deepEqual(profile.coreAuthority.m4DelegationModels, [{ modelKey: "task", maxAccess: "read" }]);
  assert.equal(profile.coreAuthority.m4RuntimeDiscovery, "authoritative");
  assert.equal(profile.coreAuthority.m4WriteAuthority, false);
  assert.deepEqual(profile.runtimeToolBoundary.m4Operations, ["discover", "query", "get"]);
  assert.equal(profile.runtimeToolBoundary.delegatedTokenConsumer, "aloha-agent-control");
  assert.equal(profile.runtimeToolBoundary.n8nReceivesLifeSpaceCredential, false);
  assert.equal(profile.runtimeToolBoundary.n8nReceivesDelegatedAgentToken, false);
  assert.equal(profile.contracts.identity, "0.6.0");
  assert.equal(profile.contracts.coreKernel, "0.37.0");
  assert.equal(profile.contracts.pinStatus, "candidate");
});

test("staging verifier derives authority from profile and proves read/deny/revocation paths", () => {
  assert.match(verifier, /aloha-integration-profile\.json/u);
  assert.match(verifier, /application\.allowedUserScopes/u);
  assert.match(verifier, /agentPolicy\.m4RequestedScopes/u);
  assert.match(verifier, /coreAuthority\.m4DelegationModels/u);
  assert.match(verifier, /coreAuthority\.m4ModelAccess/u);
  assert.match(verifier, /models\/task\/records/u);
  assert.match(verifier, /\/query/u);
  assert.match(verifier, /actions\/complete/u);
  assert.match(verifier, /Task create was not denied/u);
  assert.match(verifier, /Task\.complete was not denied/u);
  assert.match(verifier, /Revoked ALOHA M4 Delegation remained usable/u);
  assert.match(verifier, /tokenScopes\(claims\)\.includes\("resources:write"\)/u);
  assert.doesNotMatch(verifier, /lsp_pat_/u);
});

test("canonical staging deploy executes ALOHA M4 verifier after ephemeral user authority exists", () => {
  const prepare = workflow.indexOf("Prepare ephemeral authenticated staging smoke");
  const aloha = workflow.indexOf("Verify ALOHA M4 read-only delegated authority");
  const cleanup = workflow.indexOf("Cleanup ephemeral staging authority");
  assert.ok(prepare >= 0 && aloha > prepare, "ALOHA verifier must run after staging smoke prepares the user/bearer");
  assert.ok(cleanup > aloha, "ALOHA verifier must run before shared staging smoke cleanup");
  assert.match(workflow, /node --check infra\/scripts\/verify-staging-aloha-m4-read\.mjs/u);
  assert.match(workflow, /run: node infra\/scripts\/verify-staging-aloha-m4-read\.mjs/u);
});

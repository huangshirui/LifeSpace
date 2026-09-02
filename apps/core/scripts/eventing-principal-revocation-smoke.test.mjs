import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const revocationSmoke = new URL("../../../infra/scripts/verify-staging-eventing-principal-revocation.mjs", import.meta.url);
const stagingWorkflow = new URL("../../../.github/workflows/staging-deploy.yml", import.meta.url);

test("disabled-subscriber Eventing staging smoke remains syntax-valid and staging-only", () => {
  const filename = fileURLToPath(revocationSmoke);
  const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  assert.equal(result.status, 0, `${filename} failed node --check: ${result.stderr || result.stdout}`);

  const source = readFileSync(filename, "utf8");
  assert.match(source, /auth-staging\.aisr\.online/u);
  assert.match(source, /core-staging\.aisr\.online/u);
  assert.doesNotMatch(source, /(^|[^-])auth\.aisr\.online/u);
  assert.doesNotMatch(source, /(^|[^-])core\.aisr\.online/u);
  assert.doesNotMatch(source, /--env[\s"',]+production/u);
  assert.doesNotMatch(source, /webhook\.site|httpbin/iu);
});

test("disabled-subscriber Eventing smoke proves Identity disablement independently of Grant cleanup", () => {
  const source = readFileSync(fileURLToPath(revocationSmoke), "utf8");
  const disableIndex = source.indexOf('body: { status: "disabled" }');
  const mutationIndex = source.indexOf("staging Eventing mutation after principal disable");
  const grantRevokeIndex = source.indexOf('cleanup("Grant revoke"');

  assert.notEqual(disableIndex, -1, "smoke must explicitly disable the subscriber Service Principal");
  assert.notEqual(mutationIndex, -1, "smoke must create a domain mutation after principal disablement");
  assert.notEqual(grantRevokeIndex, -1, "smoke must eventually clean up the temporary Data Grant");
  assert.ok(disableIndex < mutationIndex, "principal must be disabled before the proving domain event is created");
  assert.ok(mutationIndex < grantRevokeIndex, "Data Grant cleanup must occur only after the proving mutation/delivery check");

  assert.match(source, /\/api\/v1\/spaces\/\$\{encodeURIComponent\(spaceId\)\}\/grants/u, "smoke must read current Core Grant state");
  assert.match(source, /stillActiveGrant\.revokedAt !== null/u, "smoke must fail unless the stale Grant remains active after principal disablement");
  assert.match(source, /item\.status === "cancelled"/u, "smoke must require the queued delivery to be cancelled");
  assert.match(source, /delivery\.attemptCount !== 0/u, "smoke must prove no outbound Webhook attempt began");
  assert.match(source, /delivery\.lastStatusCode != null/u, "smoke must prove no outbound HTTP status was recorded");
  assert.match(source, /subscriber service principal inactive/u, "smoke must prove cancellation happened at the Identity-state authority gate");
  assert.match(source, /grantRemainedActiveUntilAfterDeliveryCancellation:\s*true/u);
  assert.match(source, /identityStateIsSecurityBoundary:\s*true/u);
});

test("staging deployment cannot omit the disabled-subscriber Eventing authority gate", () => {
  const source = readFileSync(fileURLToPath(stagingWorkflow), "utf8");
  const positiveIndex = source.indexOf("- name: Verify real Eventing outbox/Queue/Webhook");
  const revocationIndex = source.indexOf("- name: Verify Eventing disabled-subscriber revocation boundary");

  assert.notEqual(positiveIndex, -1, "staging must retain the real positive Eventing delivery smoke");
  assert.notEqual(revocationIndex, -1, "staging must run the disabled-subscriber deny-path smoke");
  assert.ok(positiveIndex < revocationIndex, "positive Eventing delivery should be proved before principal-revocation denial");
  assert.match(source, /node --check infra\/scripts\/verify-staging-eventing-principal-revocation\.mjs/u);
  assert.match(source, /node infra\/scripts\/verify-staging-eventing-principal-revocation\.mjs/u);
  assert.match(source, /disabled Service Principal -> no outbound Webhook while stale Data Grant remains/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BASELINE_MODEL_SEMANTICS } from "../../../infra/scripts/baseline-model-semantics.mjs";
import { PROVING_MODELS } from "../../../infra/scripts/staging-expectations.mjs";

const prepareSmoke = new URL("../../../infra/scripts/prepare-staging-smoke.mjs", import.meta.url);
const cleanupSmoke = new URL("../../../infra/scripts/cleanup-staging-smoke.mjs", import.meta.url);
const eventingSmoke = new URL("../../../infra/scripts/verify-staging-eventing.mjs", import.meta.url);
const creationDraftSmoke = new URL("../../../infra/scripts/verify-staging-creation-draft.mjs", import.meta.url);
const stagingDbVerifier = new URL("../../../infra/scripts/verify-staging-db.mjs", import.meta.url);
const stagingHttpVerifier = new URL("../../../infra/scripts/verify-staging-http.mjs", import.meta.url);
const modelRegressionSmoke = new URL("../../../infra/scripts/verify-staging-models.mjs", import.meta.url);
const waitApacProbe = new URL("../../../infra/scripts/wait-staging-apac-probe.mjs", import.meta.url);
const scripts = [prepareSmoke, cleanupSmoke, eventingSmoke, creationDraftSmoke, stagingHttpVerifier, modelRegressionSmoke, waitApacProbe];
const stagingWorkflow = new URL("../../../.github/workflows/staging-deploy.yml", import.meta.url);
const apacWorkflow = new URL("../../../.github/workflows/apac-performance-gate.yml", import.meta.url);
const apacProbeConfig = new URL("../../../infra/performance-probe/wrangler.jsonc", import.meta.url);

test("authenticated staging smoke scripts remain syntax-valid and staging-only", () => {
  for (const url of scripts) {
    const filename = fileURLToPath(url);
    const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, `${filename} failed node --check: ${result.stderr || result.stdout}`);

    const source = readFileSync(filename, "utf8");
    assert.match(source, /staging/iu, `${filename} must remain explicitly staging-scoped`);
    assert.doesNotMatch(source, /--env[\s"',]+production/u, `${filename} must never target Wrangler production`);
    assert.doesNotMatch(source, /core\.aisr\.online/u, `${filename} must never target the production Core hostname`);
    assert.doesNotMatch(source, /auth\.aisr\.online/u, `${filename} must never target the production Identity hostname`);
  }
});

test("staging bootstrap masks ephemeral credentials before job export", () => {
  const source = readFileSync(fileURLToPath(prepareSmoke), "utf8");
  assert.match(source, /::add-mask::/u);
  assert.match(source, /GITHUB_ENV/u);
  assert.match(source, /15 \* 60 \* 1000/u, "service PAT should retain a bounded staging-only lifetime");
  assert.match(source, /application_model_access/u, "smoke app model authorization must be explicit");
});

test("staging proving-model checks pin semantic identity without assuming environment-local model versions", () => {
  const wish = PROVING_MODELS.find((model) => model.key === "wish");
  assert.ok(wish, "Wish must remain a staging proving model");
  assert.equal(wish.minimumVersion, 5, "Wish clean-release version remains the minimum accepted Registry version");
  assert.equal(wish.hash, "ec4f99f238e44c756905d30a97f6bb5c063b783eca159dfe39f518ea58ff64b6", "Wish staging expectation must pin the authoritative mutation-authority schema hash");
  assert.equal("version" in wish, false, "staging must not assume one exact environment-local Registry version");
  assert.equal(
    BASELINE_MODEL_SEMANTICS.wish.fields.status,
    "Whether the wish is still waiting to happen or has been fulfilled.",
    "staging semantic convergence must not republish Wish with the retired lifecycle description",
  );

  const dbSource = readFileSync(fileURLToPath(stagingDbVerifier), "utf8");
  assert.match(dbSource, /assertAtLeast\(row\.version, expected\.minimumVersion/u, "D1 convergence must accept monotonic environment-local model versions");
  assert.match(dbSource, /assertEqual\(row\.schema_hash, expected\.hash/u, "D1 convergence must still pin the exact model schema hash");
  const wishColumns = /\["mdl_wish", \[([^\]]+)\]\]/u.exec(dbSource)?.[1] ?? "";
  assert.match(wishColumns, /"fulfilledAt"/u, "Wish typed storage must retain fulfilledAt");
  assert.doesNotMatch(wishColumns, /archivedFromStatus|claimedAt/u, "Wish typed storage requirements must not retain removed workflow columns");

  const httpSource = readFileSync(fileURLToPath(stagingHttpVerifier), "utf8");
  assert.match(httpSource, /actualVersion < expected\.minimumVersion/u, "HTTP Registry verification must accept monotonic environment-local model versions");
  assert.match(httpSource, /model\.route !== expected\.route/u, "HTTP Registry verification must pin the exact route");
  assert.match(httpSource, /model\.schemaHash !== expected\.hash/u, "HTTP Registry verification must pin the exact schema hash");
  assert.match(httpSource, /currentPublishedModels/u, "HTTP verification must retain the actual current published model identity for contract comparison");
  assert.match(httpSource, /Number\(model\.version\) !== published\.version/u, "active Model Contract verification must match the exact current Registry version");

  const creationSource = readFileSync(fileURLToPath(creationDraftSmoke), "utf8");
  assert.match(creationSource, /actualVersion < expected\.minimumVersion/u, "pinned contract verification must accept environment-local versions above the release floor");
  assert.match(creationSource, /pinnedBaselineModels/u, "Creation Draft must retain the exact models from its pinned contract");
  assert.match(creationSource, /Number\(terminal\.modelVersion\) !== Number\(pinnedReadyModel\.version\)/u, "Creation Draft output must match the exact version inside its pinned contract");
});

test("staging Wish regression smoke proves the authoritative two-state lifecycle", () => {
  const source = readFileSync(fileURLToPath(modelRegressionSmoke), "utf8");

  assert.match(source, /retiredWishActions = \["claim", "unclaim", "archive", "restore"\]/u, "staging must prove retired Wish workflow actions stay absent");
  assert.match(source, /ACTION_NOT_FOUND/u, "retired Wish actions must be rejected as undefined rather than exercised as live workflow");
  assert.match(source, /actions\/fulfill/u, "an authorized user must be able to fulfill a Wish directly");
  assert.match(source, /actions\/reopen/u, "the correction path must be exercised after fulfillment");
  assert.match(source, /secondaryUserFulfill:\s*true/u, "staging must prove an authorized non-owner can fulfill directly");
  assert.match(source, /secondaryUserReopen:\s*true/u, "staging must prove an authorized non-owner can reopen for correction");
  assert.match(source, /ownerFulfill:\s*true/u, "staging must prove the Wish owner can fulfill directly");
  assert.match(source, /wish\.fulfilledAt != null/u, "open Wish smoke must accept either null or omitted nullable fulfilledAt while rejecting a real timestamp");
  assert.match(source, /reopenedBySecondary\.fulfilledAt != null/u, "reopened Wish smoke must accept either null or omitted nullable fulfilledAt while rejecting a real timestamp");
  assert.doesNotMatch(source, /wish\.fulfilledAt !== null|reopenedBySecondary\.fulfilledAt !== null/u, "staging must not require nullable output fields to be serialized explicitly as null");
  assert.doesNotMatch(source, /status !== "claimed"|claimantPersonId|ownerSelfClaimDenied|workflow:\s*"claim\/unclaim"/u, "staging regression must not retain the retired claimed-state lifecycle");
});

test("staging Creation Draft verifier tolerates only bounded transient Model Admin authentication failures", () => {
  const source = readFileSync(fileURLToPath(creationDraftSmoke), "utf8");
  assert.match(source, /modelAdminAuthAttempts = 4/u, "Creation Draft Model Admin authentication retries must remain bounded");
  assert.match(source, /last\.status === 401 \|\| last\.status >= 500/u, "only authentication and server failures should be retried");
  assert.match(source, /attempt === modelAdminAuthAttempts/u, "persistent Model Admin authentication failures must still fail the smoke");
  assert.doesNotMatch(source, /last\.status === 403/u, "authorization denials must never be retried as transient authentication");
});

test("staging Creation Draft verifier runs before long-lived Eventing and performance diagnostics", () => {
  const source = readFileSync(fileURLToPath(stagingWorkflow), "utf8");
  const creationDraftIndex = source.indexOf("- name: Verify Registry-driven Creation Draft Queue");
  const eventingIndex = source.indexOf("- name: Verify real Eventing outbox/Queue/Webhook");
  const performanceIndex = source.indexOf("- name: Measure typed-runtime staging performance");

  assert.notEqual(creationDraftIndex, -1, "staging deploy must verify the Registry-driven Creation Draft queue");
  assert.notEqual(eventingIndex, -1, "staging deploy must verify Eventing");
  assert.notEqual(performanceIndex, -1, "staging deploy must record the diagnostic performance benchmark");
  assert.ok(creationDraftIndex < eventingIndex, "Creation Draft must consume ephemeral Model Admin authority before Eventing smoke mutates temporary authority");
  assert.ok(creationDraftIndex < performanceIndex, "Creation Draft must run before the long diagnostic performance benchmark");
});

test("staging Eventing verifier proves the real signed delivery path through one shared Webhook Endpoint", () => {
  const source = readFileSync(fileURLToPath(eventingSmoke), "utf8");

  assert.match(source, /EVENT_SUBSCRIBER_ACCESS_DENIED/u, "smoke must prove subscriber Data Grant denial before authorization and after revocation");
  assert.match(source, /record\.created/u, "smoke must exercise a real domain event rather than Endpoint test-send only");
  assert.match(source, /EVENTING_SIGNING_SECRET/u, "smoke sink must verify the LifeSpace HMAC signing secret");
  assert.match(source, /\/api\/v1\/webhook-endpoints/u, "smoke must create and manage the shared Webhook Endpoint");
  assert.match(source, /endpointId[\s\S]*modelKey:\s*"event"[\s\S]*eventTypes:\s*\["record\.created"\]/u, "subscription must be a model/event filter attached to the Endpoint");
  assert.match(source, /\/api\/v1\/webhook-endpoints\/\$\{encodeURIComponent\(endpointId\)\}\/test/u, "test-send must be Endpoint-scoped");
  assert.match(source, /\/api\/v1\/webhook-endpoints\/\$\{encodeURIComponent\(endpointId\)\}\/deliveries/u, "delivery diagnostics must be Endpoint-scoped");
  assert.match(source, /endpoint\.test/u, "temporary sink must validate Endpoint test payload semantics");
  assert.match(source, /x-lifespace-webhook-endpoint-id/u, "temporary sink must validate the Endpoint delivery header");
  assert.match(source, /workers\/scripts/u, "smoke must create an ephemeral Cloudflare Worker receiver");
  assert.match(source, /workers\/domains/u, "smoke must attach an ephemeral Worker Custom Domain for Worker-to-Worker fetch correctness");
  assert.match(source, /eventing-smoke-staging-/u, "smoke hostname must remain visibly staging-scoped");
  assert.match(source, /temporary staging Custom Domain detach/u, "smoke must detach its temporary Custom Domain during cleanup");
  assert.match(source, /Webhook Endpoint delete/u, "smoke must delete its temporary Endpoint during cleanup");
  assert.match(source, /method:\s*"DELETE"/u, "smoke must delete temporary Cloudflare resources during cleanup");
  assert.match(source, /event mutation -> D1 outbox -> subscription filter -> shared Webhook Endpoint -> Cloudflare Queue -> HMAC Webhook Custom Domain/u);
  assert.match(source, /endpointTransportTestIndependentFromModelGrant:\s*true/u, "Endpoint transport/signature verification must remain independent from model Data Grants");
  assert.doesNotMatch(source, /event-subscriptions\/\$\{encodeURIComponent\(subscriptionId\)\}\/test/u, "test-send must not regress to subscription-scoped transport");
  assert.doesNotMatch(source, /\.workers\.dev/iu, "canonical Eventing smoke must not use workers.dev as a Worker-to-Worker Webhook target");
  assert.doesNotMatch(source, /webhook\.site|httpbin/iu, "staging acceptance must not depend on third-party Webhook collectors");
});

test("APAC performance gate resolves real staging D1 IDs before preparing smoke authority", () => {
  const source = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  const resolveIndex = source.indexOf("node infra/scripts/resolve-staging-d1.mjs");
  const prepareIndex = source.indexOf("node infra/scripts/prepare-staging-smoke.mjs");

  assert.notEqual(resolveIndex, -1, "APAC gate must resolve staging D1 bindings in its ephemeral checkout");
  assert.notEqual(prepareIndex, -1, "APAC gate must prepare staging smoke authority");
  assert.ok(resolveIndex < prepareIndex, "staging D1 bindings must be resolved before prepare-staging-smoke uses wrangler d1 execute");
});

test("APAC performance gate proves the real POST /run path before timed benchmark samples", () => {
  const source = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  const waitIndex = source.indexOf("node infra/scripts/wait-staging-apac-probe.mjs");
  const benchmarkIndex = source.indexOf("node infra/scripts/verify-staging-apac-performance.mjs");

  assert.notEqual(waitIndex, -1, "APAC gate must wait for the actual benchmark route, not health alone");
  assert.notEqual(benchmarkIndex, -1, "APAC gate must run the timed benchmark");
  assert.ok(waitIndex < benchmarkIndex, "real APAC probe route readiness must converge before timed samples start");

  const waitSource = readFileSync(fileURLToPath(waitApacProbe), "utf8");
  assert.match(waitSource, /\/run/u, "readiness must exercise the same POST /run entry point used by the benchmark");
  assert.match(waitSource, /tasks\?limit=1/u, "readiness probe must use a read-only Core request");
});

test("APAC performance probe remains deployable on Workers Free", () => {
  const source = readFileSync(fileURLToPath(apacProbeConfig), "utf8");
  const config = JSON.parse(source);

  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.placement, { region: "aws:ap-southeast-1" });
  assert.equal(config.limits, undefined, "Workers Free must use platform-default CPU/subrequest limits instead of custom limits");
});

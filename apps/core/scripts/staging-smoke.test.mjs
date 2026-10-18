import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BASELINE_MODEL_SEMANTICS } from "../../../infra/scripts/baseline-model-semantics.mjs";
import { PROVING_MODELS } from "../../../infra/scripts/staging-expectations.mjs";

const prepareSmoke = new URL("../../../infra/scripts/prepare-staging-smoke.mjs", import.meta.url);
const cleanupSmoke = new URL("../../../infra/scripts/cleanup-staging-smoke.mjs", import.meta.url);
const eventingSmoke = new URL("../../../infra/scripts/verify-staging-eventing.mjs", import.meta.url);
const fileSmoke = new URL("../../../infra/scripts/verify-staging-file-uploads.mjs", import.meta.url);
const stagingDbVerifier = new URL("../../../infra/scripts/verify-staging-db.mjs", import.meta.url);
const stagingHttpVerifier = new URL("../../../infra/scripts/verify-staging-http.mjs", import.meta.url);
const modelRegressionSmoke = new URL("../../../infra/scripts/verify-staging-models.mjs", import.meta.url);
const waitApacProbe = new URL("../../../infra/scripts/wait-staging-apac-probe.mjs", import.meta.url);
const scripts = [prepareSmoke, cleanupSmoke, eventingSmoke, fileSmoke, stagingHttpVerifier, modelRegressionSmoke, waitApacProbe];
const stagingWorkflow = new URL("../../../.github/workflows/staging-deploy.yml", import.meta.url);
const apacWorkflow = new URL("../../../.github/workflows/production-deploy.yml", import.meta.url);
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

test("staging scripts do not call removed domain Runtime routes", () => {
  const infraScriptsDir = new URL("../../../infra/scripts/", import.meta.url);
  const removedRuntimeRoute = /\/spaces\/\$\{[^}]+\}\/(?:tasks|events|wishes|day-records)(?:[/?`])/u;

  for (const filename of readdirSync(infraScriptsDir).filter((name) => name.endsWith(".mjs"))) {
    const source = readFileSync(new URL(filename, infraScriptsDir), "utf8");
    assert.doesNotMatch(source, removedRuntimeRoute, `${filename} must use /models/{modelKey}/records`);
  }
});

test("staging bootstrap masks ephemeral credentials before job export", () => {
  const source = readFileSync(fileURLToPath(prepareSmoke), "utf8");
  assert.match(source, /::add-mask::/u);
  assert.match(source, /GITHUB_ENV/u);
  assert.match(source, /15 \* 60 \* 1000/u, "service PAT should retain a bounded staging-only lifetime");
  assert.match(source, /application_model_access/u, "smoke app model authorization must be explicit");
  assert.match(
    source,
    /requestUntil\([\s\S]{0,200}"Core Runtime service-token verification"[\s\S]{0,300}\n\s*20,\n\s*2500,/u,
    "the canonical Runtime probe must tolerate bounded edge deployment convergence",
  );
});


test("staging proving-model checks pin semantic identity without assuming environment-local model versions", () => {
  const wish = PROVING_MODELS.find((model) => model.key === "wish");
  assert.ok(wish, "Wish must remain a staging proving model");
  assert.equal(wish.minimumVersion, 8, "Wish modelKey-addressed release version remains the minimum accepted Registry version");
  assert.equal(wish.hash, "772e17c1d07ba620c879b90b60b1c74dd1629edeffc5e5f622b57eb43c74e934", "Wish staging expectation must pin the modelKey-addressed schema hash");
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
  assert.match(httpSource, /"route" in model/u, "HTTP Registry verification must reject the removed route identity");
  assert.match(httpSource, /model\.schemaHash !== expected\.hash/u, "HTTP Registry verification must pin the exact schema hash");
  assert.match(httpSource, /currentPublishedModels/u, "HTTP verification must retain the actual current published model identity for contract comparison");
  assert.match(httpSource, /Number\(model\.version\) !== published\.version/u, "active Model Contract verification must match the exact current Registry version");


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
  assert.match(waitSource, /models\/task\/records\?limit=1/u, "readiness probe must use the canonical modelKey-addressed read-only request");
});

test("APAC performance probe remains deployable on Workers Free", () => {
  const source = readFileSync(fileURLToPath(apacProbeConfig), "utf8");
  const config = JSON.parse(source);

  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.placement, { region: "aws:ap-southeast-1" });
  assert.equal(config.limits, undefined, "Workers Free must use platform-default CPU/subrequest limits instead of custom limits");
});

test("File V1 staging release preserves manual approval and gates on real signed R2/Notion upload", () => {
  const workflow = readFileSync(fileURLToPath(stagingWorkflow), "utf8");
  const native = readFileSync(fileURLToPath(fileSmoke), "utf8");
  const external = readFileSync(new URL("../../../infra/scripts/verify-staging-external-self-service.mjs", import.meta.url), "utf8");
  const production = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/mu, "staging must remain a manual owner-controlled release");
  const preflight = workflow.indexOf("test -n \"\${R2_S3_ACCESS_KEY_ID:-}\"");
  const migration = workflow.indexOf("Apply Core migrations");
  assert.ok(preflight > -1 && preflight < migration, "R2 signing prerequisites must be checked before migration");
  assert.match(workflow, /wrangler secret put R2_S3_ACCESS_KEY_ID --env staging/u);
  assert.match(workflow, /wrangler secret put R2_S3_SECRET_ACCESS_KEY --env staging/u);
  assert.match(workflow, /node infra\/scripts\/verify-staging-file-uploads\.mjs/u);
  assert.match(workflow, /node infra\/scripts\/verify-staging-external-self-service\.mjs/u);
  assert.match(native, /uploads\/native\//u);
  assert.match(native, /\/file-downloads/u);
  assert.ok(native.includes("/files/\${file}"), "Native File smoke must verify governed File deletion");
  assert.match(external, /checks\.providerFileUpload = true/u);
  assert.ok(external.includes("file-uploads/\${session.id}/complete"), "External smoke must finish Notion upload via LifeSpace");
  assert.match(production, /wrangler secret put R2_S3_ACCESS_KEY_ID --env production/u);
  assert.match(production, /wrangler secret put R2_S3_SECRET_ACCESS_KEY --env production/u);
});

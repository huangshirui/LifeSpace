import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createApacProbeRequestAdapter } from "./apac-probe-client.mjs";
import { APAC_RELEASE_SAMPLE_COUNT } from "./performance-release-targets.mjs";
import { planApacConfirmation, evaluateApacConfirmation, APAC_CONFIRMATION_ROUNDS } from "./apac-release-acceptance.mjs";
import { runStagingPerformanceBenchmark } from "./staging-canonical-performance-benchmark.mjs";
import { runStagingServicePerformanceBenchmark } from "./staging-service-performance-benchmark.mjs";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const userBearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const serviceBearer = process.env.LIFESPACE_STAGING_SERVICE_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const probeUrl = (process.env.LIFESPACE_APAC_PROBE_URL ?? "").replace(/\/+$/u, "");
const probeToken = process.env.LIFESPACE_APAC_PROBE_TOKEN ?? "";

for (const [name, value] of Object.entries({
  LIFESPACE_CORE_STAGING_URL: coreBaseUrl,
  LIFESPACE_STAGING_USER_BEARER: userBearer,
  LIFESPACE_STAGING_SERVICE_BEARER: serviceBearer,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
  LIFESPACE_APAC_PROBE_URL: probeUrl,
  LIFESPACE_APAC_PROBE_TOKEN: probeToken,
})) {
  if (!value) throw new Error(`${name} is required`);
}

function requirePlatformGoldenFlow() {
  const verifier = fileURLToPath(new URL("./verify-staging-platform-golden-flow.mjs", import.meta.url));
  console.log("Re-validating the LifeSpace platform staging Golden Flow before Production promotion...");
  const result = spawnSync(process.execPath, [verifier], {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`LifeSpace platform staging Golden Flow failed before APAC promotion (exit ${String(result.status)})`);
  }
}

function requestThroughApacProbe(credentialMode) {
  return createApacProbeRequestAdapter({
    probeUrl,
    probeToken,
    credentialMode,
  });
}

// Production promotion must prove functional governance semantics immediately before
// performance acceptance. This prevents any alternate staging mutation/provisioning
// path from satisfying version/schema checks while bypassing the canonical Golden Flow.
requirePlatformGoldenFlow();

const userAdapter = requestThroughApacProbe("user");
const serviceAdapter = requestThroughApacProbe("service");

const userResult = await runStagingPerformanceBenchmark({
  coreBaseUrl,
  bearer: userBearer,
  spaceId,
  personId,
  benchmarkProfile: "apac",
  source: "Temporary Cloudflare Worker explicitly targeted near aws:ap-southeast-1 -> LifeSpace Core staging (user JWT)",
  sampleCount: APAC_RELEASE_SAMPLE_COUNT,
  mutationSampleCount: APAC_RELEASE_SAMPLE_COUNT,
  requestAdapter: userAdapter,
});

const serviceResult = await runStagingServicePerformanceBenchmark({
  coreBaseUrl,
  bearer: serviceBearer,
  spaceId,
  benchmarkProfile: "apac",
  source: "Temporary Cloudflare Worker explicitly targeted near aws:ap-southeast-1 -> LifeSpace Core staging (opaque lsp_svc_* Service API Token)",
  sampleCount: APAC_RELEASE_SAMPLE_COUNT,
  mutationSampleCount: APAC_RELEASE_SAMPLE_COUNT,
  requestAdapter: serviceAdapter,
});


function summarizeProbeDiagnostics(observations) {
  const groups = new Map();
  for (const item of observations) {
    const group = groups.get(item.route) ?? [];
    group.push(item);
    groups.set(item.route, group);
  }
  const p = (samples, percentile) => {
    const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    return Number(sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)].toFixed(1));
  };
  return [...groups.entries()].map(([route, samples]) => ({
    route, count: samples.length,
    coreHeadersP50Ms: p(samples.map((s) => s.coreHeadersMs), 50),
    coreHeadersP90Ms: p(samples.map((s) => s.coreHeadersMs), 90),
    coreBodyP90Ms: p(samples.map((s) => s.coreBodyMs), 90),
    runnerToProbeP90Ms: p(samples.map((s) => s.runnerToProbeMs), 90),
    probeIngressColos: [...new Set(samples.map((s) => s.probeIngressColo).filter(Boolean))].sort(),
  }));
}

console.log(JSON.stringify({
  APAC_DIAGNOSTIC_ONLY: true,
  note: "Core header time is unchanged for release gates; runner-to-probe includes the GitHub runner leg. Probe ingress colo does not attest actual Worker compute placement.",
  user: summarizeProbeDiagnostics(userAdapter.diagnostics()),
  service: summarizeProbeDiagnostics(serviceAdapter.diagnostics()),
}, null, 2));

// Only the narrow first-round P90 gray zone qualifies for confirmation.
// Repeat the exact failed scenarios, never drop a slow sample or alter P50/P90 targets.
const initial = { user: userResult, service: serviceResult };
const plan = planApacConfirmation(initial, APAC_RELEASE_SAMPLE_COUNT);
const confirmation = { user: [], service: [] };
if (plan.status === "confirm") {
  console.log(JSON.stringify({ APAC_BORDERLINE_CONFIRMATION: true, selectedScenarios: plan.retest }));
  for (let round = 2; round <= APAC_CONFIRMATION_ROUNDS; round += 1) {
    if (plan.retest.user.length) {
      confirmation.user.push(await runStagingPerformanceBenchmark({
        coreBaseUrl, bearer: userBearer, spaceId, personId, benchmarkProfile: "apac",
        source: `APAC confirmation batch ${round} (user JWT)`,
        sampleCount: APAC_RELEASE_SAMPLE_COUNT, mutationSampleCount: APAC_RELEASE_SAMPLE_COUNT,
        requestAdapter: userAdapter, selectedScenarios: plan.retest.user,
      }));
    }
    if (plan.retest.service.length) {
      confirmation.service.push(await runStagingServicePerformanceBenchmark({
        coreBaseUrl, bearer: serviceBearer, spaceId, benchmarkProfile: "apac",
        source: `APAC confirmation batch ${round} (Service API Token)`,
        sampleCount: APAC_RELEASE_SAMPLE_COUNT, mutationSampleCount: APAC_RELEASE_SAMPLE_COUNT,
        requestAdapter: serviceAdapter, selectedScenarios: plan.retest.service,
      }));
    }
  }
}
const decision = plan.status === "confirm"
  ? evaluateApacConfirmation(initial, confirmation, plan.retest, APAC_RELEASE_SAMPLE_COUNT)
  : plan;
console.log(JSON.stringify({ APAC_RELEASE_DECISION: decision,
  initial: { user: userResult, service: serviceResult },
  confirmation: plan.status === "confirm" ? confirmation : undefined }, null, 2));
if (decision.status !== "passed") {
  throw new Error(`Staging APAC performance release gate blocked: ${JSON.stringify(decision)}`);
}

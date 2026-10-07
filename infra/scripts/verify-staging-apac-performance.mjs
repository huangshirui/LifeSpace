import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
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
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${probeUrl}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-lifespace-probe-token": probeToken,
      },
      body: JSON.stringify({ path, method, credentialMode, ...(body === undefined ? {} : { body }) }),
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`APAC probe returned non-JSON ${response.status}: ${text.slice(0, 500)}`);
    }
    if (!response.ok) {
      throw new Error(`APAC probe failed ${response.status}: ${JSON.stringify(payload)}`);
    }
    if (!payload || !Number.isInteger(payload.status) || typeof payload.elapsedMs !== "number") {
      throw new Error(`APAC probe returned an invalid benchmark result: ${JSON.stringify(payload)}`);
    }
    if (payload.credentialMode !== credentialMode) {
      throw new Error(`APAC probe credential mode mismatch: expected ${credentialMode}, got ${JSON.stringify(payload.credentialMode)}`);
    }
    return payload;
  };
}

// Production promotion must prove functional governance semantics immediately before
// performance acceptance. This prevents any alternate staging mutation/provisioning
// path from satisfying version/schema checks while bypassing the canonical Golden Flow.
requirePlatformGoldenFlow();

const userResult = await runStagingPerformanceBenchmark({
  coreBaseUrl,
  bearer: userBearer,
  spaceId,
  personId,
  benchmarkProfile: "apac",
  source: "Temporary Cloudflare Worker explicitly targeted near aws:ap-southeast-1 -> LifeSpace Core staging (user JWT)",
  requestAdapter: requestThroughApacProbe("user"),
});

const serviceResult = await runStagingServicePerformanceBenchmark({
  coreBaseUrl,
  bearer: serviceBearer,
  spaceId,
  benchmarkProfile: "apac",
  source: "Temporary Cloudflare Worker explicitly targeted near aws:ap-southeast-1 -> LifeSpace Core staging (opaque lsp_pat_*)",
  requestAdapter: requestThroughApacProbe("service"),
});

console.log(JSON.stringify({ user: userResult, service: serviceResult }, null, 2));

if (!userResult.acceptanceEligible || !userResult.allTargetsMet) {
  throw new Error(`Staging APAC user performance target missed: ${JSON.stringify({
    reads: userResult.readTargetsMet,
    mutations: userResult.mutationTargetsMet,
  })}`);
}
if (!serviceResult.acceptanceEligible || !serviceResult.allTargetsMet) {
  throw new Error(`Staging APAC Service PAT performance target missed: ${JSON.stringify({
    reads: serviceResult.readTargetsMet,
    mutations: serviceResult.mutationTargetsMet,
  })}`);
}

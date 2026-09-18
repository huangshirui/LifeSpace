import process from "node:process";
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

if (!userResult.acceptanceEligible || !userResult.allReadTargetsMet) {
  throw new Error(`Staging APAC user read performance target missed: ${JSON.stringify(userResult.readTargetsMet)}`);
}
if (!serviceResult.acceptanceEligible || !serviceResult.allReadTargetsMet) {
  throw new Error(`Staging APAC Service PAT read performance target missed: ${JSON.stringify(serviceResult.readTargetsMet)}`);
}

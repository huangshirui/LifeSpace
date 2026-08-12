import process from "node:process";
import { runStagingPerformanceBenchmark } from "./staging-performance-benchmark.mjs";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const bearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const probeUrl = (process.env.LIFESPACE_APAC_PROBE_URL ?? "").replace(/\/+$/u, "");
const probeToken = process.env.LIFESPACE_APAC_PROBE_TOKEN ?? "";

for (const [name, value] of Object.entries({
  LIFESPACE_CORE_STAGING_URL: coreBaseUrl,
  LIFESPACE_STAGING_USER_BEARER: bearer,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
  LIFESPACE_APAC_PROBE_URL: probeUrl,
  LIFESPACE_APAC_PROBE_TOKEN: probeToken,
})) {
  if (!value) throw new Error(`${name} is required`);
}

async function requestThroughApacProbe(path, { method = "GET", body } = {}) {
  const response = await fetch(`${probeUrl}/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lifespace-probe-token": probeToken,
    },
    body: JSON.stringify({ path, method, ...(body === undefined ? {} : { body }) }),
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
  return payload;
}

const result = await runStagingPerformanceBenchmark({
  coreBaseUrl,
  bearer,
  spaceId,
  personId,
  benchmarkProfile: "apac",
  source: "Temporary Cloudflare Worker explicitly targeted near aws:ap-southeast-1 -> LifeSpace Core staging",
  requestAdapter: requestThroughApacProbe,
});

console.log(JSON.stringify(result, null, 2));

if (!result.acceptanceEligible || !result.allReadTargetsMet) {
  throw new Error(`Staging APAC read performance target missed: ${JSON.stringify(result.readTargetsMet)}`);
}

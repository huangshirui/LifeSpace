import process from "node:process";
import { runStagingPerformanceBenchmark } from "./staging-canonical-performance-benchmark.mjs";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const bearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const enforce = process.env.ENFORCE_PERFORMANCE_TARGETS === "1";
const benchmarkProfile = process.env.PERFORMANCE_BENCHMARK_PROFILE ?? "diagnostic-github";
const acceptanceEligible = benchmarkProfile === "apac";

for (const [name, value] of Object.entries({
  LIFESPACE_CORE_STAGING_URL: coreBaseUrl,
  LIFESPACE_STAGING_USER_BEARER: bearer,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

if (enforce && !acceptanceEligible) {
  throw new Error(`Refusing to enforce absolute latency targets for non-APAC benchmark profile: ${benchmarkProfile}`);
}

const result = await runStagingPerformanceBenchmark({
  coreBaseUrl,
  bearer,
  spaceId,
  personId,
  benchmarkProfile,
  source: acceptanceEligible
    ? "Representative APAC runner/client to Cloudflare staging"
    : "GitHub-hosted runner to Cloudflare staging; runner geography is uncontrolled for acceptance",
});

console.log(JSON.stringify(result, null, 2));

if (enforce && !result.allReadTargetsMet) {
  throw new Error(`Staging APAC read performance target missed: ${JSON.stringify(result.readTargetsMet)}`);
}

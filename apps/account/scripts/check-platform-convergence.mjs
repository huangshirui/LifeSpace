import { STAGING_EXPECTATIONS } from "../../../infra/scripts/staging-expectations.mjs";
import { pathToFileURL } from "node:url";
import process from "node:process";

export function matchStagingStatus(actual, expected) {
  return actual?.environment === "staging"
    && actual.contractVersion === expected.contractVersion
    && Number(actual.schemaVersion) === expected.schemaVersion;
}
export async function assertStagingConverged(fetcher = fetch) {
  const results = {};
  for (const [key, base] of [
    ["core", "https://core-staging.aisr.online"],
    ["identity", "https://auth-staging.aisr.online"],
  ]) {
    const response = await fetcher(base + "/api/v1/status", {
      headers: { accept: "application/json" },
    });
    const data = (await response.json().catch(() => null))?.data;
    if (!response.ok || !matchStagingStatus(data, STAGING_EXPECTATIONS[key])) {
      throw new Error(key + " Staging is not converged to the reviewed main commit; run canonical staging-deploy first");
    }
    results[key] = {
      environment: data.environment, contractVersion: data.contractVersion,
      schemaVersion: data.schemaVersion,
    };
  }
  return { ok: true, serviceVersions: results, noMutations: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await assertStagingConverged(), null, 2));
}

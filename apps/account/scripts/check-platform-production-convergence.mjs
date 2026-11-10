// Read-only guard: Account first-use setup requires completed matching
// Core/Identity Production deployment and migrations.
import { pathToFileURL } from "node:url";
import { PRODUCTION_EXPECTATIONS } from "../../../infra/scripts/production-expectations.mjs";

export function matchesProductionRelease(actual, expected) {
  return actual?.environment === "production"
    && actual.contractVersion === expected.contractVersion
    && Number(actual.schemaVersion) === expected.schemaVersion;
}

export async function assertProductionConverged(fetcher = fetch) {
  const result = {};
  for (const [service, origin] of [
    ["core", "https://core.aisr.online"], ["identity", "https://auth.aisr.online"],
  ]) {
    const response = await fetcher(origin + "/api/v1/status", {
      headers: { accept: "application/json" },
    });
    const data = (await response.json().catch(() => null))?.data;
    if (!response.ok || !matchesProductionRelease(data, PRODUCTION_EXPECTATIONS[service])) {
      throw new Error(service + " Production is not at this reviewed release: run canonical Platform Production first");
    }
    result[service] = { environment: data.environment, schemaVersion: data.schemaVersion,
      contractVersion: data.contractVersion };
  }
  return { ok: true, components: result, noMutations: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await assertProductionConverged()));
}

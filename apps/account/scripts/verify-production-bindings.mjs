// Read-only cross-Worker Production OAuth/Account bindings and isolation check.
// Never reads secret values. This check is deliberately not used by the
// first-time bootstrap until the private Adapter and Account workers exist.
import { pathToFileURL } from "node:url";

const expected = Object.freeze({
  "lifespace-account": {
    services: { IDENTITY: "lifespace-identity", CORE: "lifespace-core" },
    secrets: ["IDENTITY_APPLICATION_CREDENTIAL", "ACCOUNT_CSRF_SECRET"],
  },
  "lifespace-core": {
    services: { IDENTITY: "lifespace-identity", MCP_ADAPTER: "lifespace-mcp-adapter" },
    secrets: ["OAUTH_ACCOUNT_APPLICATION_ID", "OAUTH_CORE_APPROVER_SECRET"],
  },
  "lifespace-identity": {
    services: { CORE: "lifespace-core" },
    secrets: ["OAUTH_ACCOUNT_APPLICATION_ID", "OAUTH_ISSUER", "OAUTH_CONSENT_URL",
      "OAUTH_CORE_APPROVER_SECRET", "OAUTH_RESOURCE_SERVER_SECRET"],
  },
  "lifespace-mcp-adapter": {
    services: { CORE: "lifespace-core", IDENTITY: "lifespace-identity" },
    secrets: ["OAUTH_RESOURCE_SERVER_SECRET"],
  },
});

export function assertProductionWorkerBindings(name, bindings) {
  const requirement = expected[name];
  if (!requirement || !Array.isArray(bindings)) {
    throw new Error("Required Production Worker settings are missing");
  }
  const services = Object.fromEntries(bindings.filter(x => x.type === "service")
    .map(x => [x.name, x.service]));
  for (const [binding, target] of Object.entries(requirement.services)) {
    if (services[binding] !== target) {
      throw new Error("Cross-environment or missing Service Binding: " + name + "/" + binding);
    }
  }
  const names = new Set(bindings.filter(x => x.type === "secret_text").map(x => x.name));
  const missing = requirement.secrets.filter(secret => !names.has(secret));
  if (missing.length) {
    throw new Error("Missing protected Production secret binding names: "
      + name + " / " + missing.join(", "));
  }
  if (name === "lifespace-account" && bindings.some(x => [
    "d1", "kv_namespace", "r2_bucket", "queue", "durable_object_namespace",
  ].includes(x.type))) {
    throw new Error("Account Production may not own platform persistence");
  }
  return { worker: name, checkedServices: Object.keys(requirement.services).length,
    checkedSecretNames: requirement.secrets.length, secretValuesInspected: false };
}

export async function verifyProductionWorkerBindings({ env = process.env, fetcher = fetch } = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = env.CLOUDFLARE_API_TOKEN || "";
  if (!/^[a-f0-9]{32}$/iu.test(accountId) || !token) {
    throw new Error("Read-only Production binding verification requires protected credentials");
  }
  const results = [];
  for (const worker of Object.keys(expected)) {
    const path = "/accounts/" + accountId + "/workers/scripts/" + worker + "/settings";
    const response = await fetcher("https://api.cloudflare.com/client/v4" + path,
      { headers: { authorization: "Bearer " + token, accept: "application/json" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.result?.bindings)) {
      throw new Error("Production Worker missing or inaccessible: " + worker);
    }
    results.push(assertProductionWorkerBindings(worker, payload.result.bindings));
  }
  return { ok: true, workers: results, noMutations: true, secretValuesInspected: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyProductionWorkerBindings()));
}

// Fail-closed guard for FIRST-TIME Account Production setup only.
// Never rotates, overwrites or interprets existing OAuth secrets. Partial
// previous setups require an explicitly reviewed recovery procedure.
import { pathToFileURL } from "node:url";

export function assertFirstUseProductionBindings(core, identity, adapter, accountExists) {
  if (accountExists) throw new Error("Account Production already exists: no implicit re-provisioning");
  const service = rows => Object.fromEntries(rows.filter(x => x.type === "service")
    .map(x => [x.name, x.service]));
  if (service(core).MCP_ADAPTER !== "lifespace-mcp-adapter"
    || service(core).IDENTITY !== "lifespace-identity"
    || service(identity).CORE !== "lifespace-core"
    || service(adapter).CORE !== "lifespace-core"
    || service(adapter).IDENTITY !== "lifespace-identity") {
    throw new Error("Production Core/Identity/private Adapter must be deployed with same-environment bindings first");
  }
  const secrets = rows => new Set(rows.filter(x => x.type === "secret_text").map(x => x.name));
  if (!secrets(adapter).has("OAUTH_RESOURCE_SERVER_SECRET")) {
    throw new Error("Private Adapter Production must have paired OAuth Resource Secret pre-provisioned");
  }
  for (const [worker, rows] of [["Core", core], ["Identity", identity]]) {
    const names = secrets(rows);
    if (["OAUTH_ACCOUNT_APPLICATION_ID", "OAUTH_CORE_APPROVER_SECRET",
      "OAUTH_CONSENT_URL", "OAUTH_RESOURCE_SERVER_SECRET", "OAUTH_ISSUER"]
      .some(x => names.has(x))) {
      throw new Error(worker + " already has OAuth setup; first-use bootstrap must not rotate it");
    }
  }
  return { ok: true, firstUseOnly: true, noMutations: true };
}

export async function checkProductionFirstUse({ env = process.env, fetcher = fetch } = {}) {
  const id = env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = env.CLOUDFLARE_API_TOKEN || "";
  if (!/^[a-f0-9]{32}$/iu.test(id) || !token) throw new Error("Protected Cloudflare API credentials required");
  async function settings(name, missingAllowed = false) {
    const response = await fetcher("https://api.cloudflare.com/client/v4/accounts/" + id
      + "/workers/scripts/" + name + "/settings", { headers: {
        authorization: "Bearer " + token, accept: "application/json",
      } });
    if (missingAllowed && response.status === 404) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.result?.bindings)) {
      throw new Error("Production prerequisite Worker missing: " + name);
    }
    return payload.result.bindings;
  }
  const [core, identity, adapter, account] = await Promise.all([
    settings("lifespace-core"), settings("lifespace-identity"),
    settings("lifespace-mcp-adapter"), settings("lifespace-account", true),
  ]);
  return assertFirstUseProductionBindings(core, identity, adapter, account !== null);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkProductionFirstUse()));
}

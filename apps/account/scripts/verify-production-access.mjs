// Read-only Production Account perimeter verification for routine code-only deploys.
import { pathToFileURL } from "node:url";
import { requireSingle } from "./prepare-staging-access.mjs";
import { ACCOUNT_PRODUCTION_DOMAIN, requireProductionAccountAccess } from "./prepare-production-access.mjs";

export async function verifyProductionAccountAccess({ env = process.env, fetcher = fetch } = {}) {
  const id = env.CLOUDFLARE_ACCOUNT_ID || "";
  const token = env.CLOUDFLARE_API_TOKEN || "";
  if (!/^[a-f0-9]{32}$/iu.test(id) || !token) {
    throw new Error("Read-only Production Access verification requires protected credentials");
  }
  const base = "https://api.cloudflare.com/client/v4/accounts/" + id;
  async function get(path) {
    const response = await fetcher(base + path, { headers: {
      authorization: "Bearer " + token, accept: "application/json",
    } });
    const json = await response.json().catch(() => null);
    if (!response.ok || json?.success !== true) {
      throw new Error("Read-only Production Access inspection failed (HTTP " + response.status + ")");
    }
    return json.result;
  }
  const applications = await get("/access/apps?per_page=100");
  if (!Array.isArray(applications)) throw new Error("Invalid Production Access applications list");
  const app = requireSingle(applications, ACCOUNT_PRODUCTION_DOMAIN);
  const consoleApp = requireSingle(applications, "lifespace.aisr.online");
  if (!app?.id || !consoleApp?.id) {
    throw new Error("Account/Console Production Access protection missing; run owner setup first");
  }
  const [detail, policies, baseline] = await Promise.all([
    get("/access/apps/" + encodeURIComponent(app.id)),
    get("/access/apps/" + encodeURIComponent(app.id) + "/policies?per_page=100"),
    get("/access/apps/" + encodeURIComponent(consoleApp.id) + "/policies?per_page=100"),
  ]);
  if (app.aud !== detail.aud || app.id !== detail.id) {
    throw new Error("Production Account Access audience or application changed");
  }
  requireProductionAccountAccess(detail, policies, baseline);
  return { ok: true, domain: ACCOUNT_PRODUCTION_DOMAIN,
    ownerOnlyPolicyVerified: true, audiencePresent: true,
    mutations: false, noAccountD1: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyProductionAccountAccess()));
}

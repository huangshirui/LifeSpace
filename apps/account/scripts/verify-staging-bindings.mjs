import { pathToFileURL } from "node:url";
import process from "node:process";

const required = {
  "lifespace-account-staging": ["IDENTITY_APPLICATION_CREDENTIAL", "ACCOUNT_CSRF_SECRET"],
  "lifespace-core-staging": ["OAUTH_CORE_APPROVER_SECRET"],
  "lifespace-identity-staging": ["OAUTH_CORE_APPROVER_SECRET"],
};
export function missingBindings(existingNames, expectedNames) {
  const found = new Set(existingNames);
  return expectedNames.filter(name => !found.has(name));
}
export async function verifyStagingBindings({ env = process.env, fetcher = fetch } = {}) {
  const id = env.CLOUDFLARE_ACCOUNT_ID || "", token = env.CLOUDFLARE_API_TOKEN || "";
  if (!/^[a-f0-9]{32}$/iu.test(id) || !token) throw new Error("Read-only Cloudflare API credentials are required");
  const states = {};
  for (const [script, expected] of Object.entries(required)) {
    const url = "https://api.cloudflare.com/client/v4/accounts/" + id
      + "/workers/scripts/" + encodeURIComponent(script) + "/secrets";
    const response = await fetcher(url, { headers: {
      authorization: "Bearer " + token, accept: "application/json",
    } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success !== true || !Array.isArray(payload.result)) {
      throw new Error("Worker secret-binding inspection failed: " + script);
    }
    const missing = missingBindings(payload.result.map(row => row.name), expected);
    if (missing.length) throw new Error("Staging Worker lacks required named bindings: " + script + " / " + missing.join(", "));
    states[script] = { ok: true, namedBindingsVerified: expected.length, plaintextInspected: false };
  }
  return { ok: true, noProductionChanges: true, accountD1Created: false, scripts: states };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await verifyStagingBindings(), null, 2));
}

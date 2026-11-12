// Owner-controlled Staging-only secret convergence for Identity + private
// MCP Adapter. Generates one random secret per invocation; never stores,
// prints, logs or exposes its value in GitHub, repository files or outputs.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";

const IDENTITY = "lifespace-identity-staging";
const ADAPTER = "lifespace-mcp-adapter-staging";
const TARGETS = [IDENTITY, ADAPTER];
const NAME = "OAUTH_RESOURCE_SERVER_SECRET";

export async function convergeStagingMcpResourceSecret({
  accountId, token, request = fetch, secretGenerator = () => randomBytes(48).toString("base64url"),
} = {}) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/u.test(accountId)
    || typeof token !== "string" || token.length < 20) {
    throw new Error("Protected Cloudflare account and API token are required");
  }
  const origin = "https://api.cloudflare.com/client/v4/accounts/" + accountId + "/workers/scripts";
  const headers = { authorization: "Bearer " + token, accept: "application/json" };
  // Verify BOTH exact staging-only Workers exist before changing either secret.
  let index;
  try { index = await request(origin, { method: "GET", headers }); }
  catch { throw new Error("Unable to inspect staging Worker inventory"); }
  if (!index.ok) throw new Error("Unable to inspect staging Worker inventory");
  let listing;
  try { listing = await index.json(); } catch { throw new Error("Invalid Worker inventory"); }
  if (listing?.success !== true) throw new Error("Cloudflare staging Worker inventory was not confirmed");
  const available = new Set(Array.isArray(listing?.result)
    ? listing.result.map(worker => worker?.id || worker?.name).filter(Boolean) : []);
  if (!TARGETS.every(name => available.has(name))) {
    throw new Error("Both exact private Adapter and Identity staging Workers must exist before secret convergence");
  }

  const value = secretGenerator();
  if (typeof value !== "string" || value.length < 48 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Unsafe random Resource Server credential");
  }
  // The value is never interpolated into an error, URL, log or result.
  // On partial failure rerun this idempotent pairing step; until both
  // successfully match, OAuth introspection fails closed.
  for (const name of TARGETS) {
    const endpoint = origin + "/" + name + "/secrets";
    const response = await request(endpoint, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: NAME, type: "secret_text", text: value }),
    }).catch(() => null);
    const outcome = response?.ok ? await response.json().catch(() => null) : null;
    if (outcome?.success !== true) {
      throw new Error("Staging Resource Server secret convergence failed for " + name);
    }
  }
  for (const name of TARGETS) {
    const response = await request(origin + "/" + name + "/secrets", {
      method: "GET", headers,
    }).catch(() => null);
    if (!response?.ok) throw new Error("Staging Worker secret name verification failed for " + name);
    const payload = await response.json().catch(() => null);
    if (payload?.success !== true || !Array.isArray(payload.result)
      || !payload.result.some(binding => binding.name === NAME)) {
      throw new Error("Expected Staging Resource Server secret binding missing for " + name);
    }
  }
  return { ok: true, environment: "staging", workers: TARGETS,
    sharedSecretConfigured: true, plaintextExposed: false, productionTouched: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await convergeStagingMcpResourceSecret({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log(JSON.stringify(result, null, 2));
}

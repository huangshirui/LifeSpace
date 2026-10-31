import { verifyMcpStagingApplication } from "./mcp-staging-app-identity.mjs";
// Install an existing, human-approved LifeSpace MCP Application credential.
// This script NEVER creates/modifies Applications, OAuth audiences, Grants,
// service principals or user authority. Admin governance belongs in Console.
const identityBase = "https://auth-staging.aisr.online";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const appCredential = process.env.LIFESPACE_STAGING_MCP_APPLICATION_CREDENTIAL ?? "";
const appId = process.env.LIFESPACE_STAGING_MCP_APPLICATION_ID ?? "";
const action = process.env.MCP_CREDENTIAL_INSTALL_ACTION ?? "";
const appName = "LifeSpace MCP Staging";
const hostname = "mcp-staging.aisr.online";
const workerName = "lifespace-mcp-staging";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(/^[0-9a-f]{32}$/u.test(accountId), "Cloudflare account ID missing or malformed");
assert(cfToken.length >= 20, "Cloudflare API token missing");
assert(/^lsa_[a-zA-Z0-9_-]{20,}$/u.test(appCredential), "MCP Application credential is missing or malformed");
// An optional configured ID provides another cross-check; the lsa_* self endpoint is authoritative.
assert(action === "INSTALL_MCP_STAGING" || action === "ROTATE_MCP_STAGING",
  "Explicit install/rotate confirmation is required");

async function request(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error", signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}
async function cloudflare(path, options = {}) {
  const result = await request("https://api.cloudflare.com/client/v4" + path, {
    ...options, headers: { authorization: "Bearer " + cfToken, ...options.headers },
  });
  assert(result.payload?.success === true, "Cloudflare operation failed with status " + result.status);
  return result.payload.result;
}

// Validate that the target Identity service is Staging before trusting an app credential.
const status = await request(identityBase + "/api/v1/status");
assert(status.status === 200 && status.payload?.data?.environment === "staging",
  "Refusing to install credential before Staging Identity convergence");

// No arbitrary app metadata lookup, Bootstrap auth or fake human admin actor.
// Self-introspection proves the credential belongs to an active trusted app with
// the intended identity and *exactly* the read-only scope ceiling.
const own = await request(identityBase + "/internal/v1/applications/self", {
  headers: { authorization: "Bearer " + appCredential },
});
const application = own.payload?.data;
assert(own.status === 200, "Identity refused the MCP Application credential self-inspection");
const { idSource } = verifyMcpStagingApplication(application, appId);

// Cloudflare owns OAuth. This is NOT a way of registering OAuth clients or
// a workaround to the legitimate human-operated LifeSpace Console.
const apps = await cloudflare("/accounts/" + accountId + "/access/apps?domain="
  + encodeURIComponent(hostname) + "&exact=true");
assert(Array.isArray(apps) && apps.filter(a => a.domain === hostname).length === 1,
  "MCP Staging Access application is missing or ambiguous");
const accessApp = apps.find(a => a.domain === hostname && a.name === appName);
assert(accessApp, "Unexpected protected Access application");
const access = await cloudflare("/accounts/" + accountId + "/access/apps/" + encodeURIComponent(accessApp.id));
assert(access.type === "self_hosted" && access.oauth_configuration?.enabled === true
  && typeof access.aud === "string" && access.aud.length >= 20,
  "Cloudflare Managed OAuth is not enabled for the dedicated MCP Staging app");
const policies = await cloudflare("/accounts/" + accountId + "/access/apps/" + encodeURIComponent(accessApp.id) + "/policies");
assert(Array.isArray(policies) && policies.length === 1 && policies[0].decision === "allow"
  && Array.isArray(policies[0].include) && policies[0].include.length > 0
  && policies[0].include.every(rule => Object.keys(rule).length === 1 && !!rule.email?.email),
  "Only explicit test-user email allow policies are accepted");

// Prevent installing secrets in a public or cross-environment Worker.
const subdomain = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/subdomain");
assert(subdomain.enabled !== true && subdomain.previews_enabled !== true,
  "MCP Worker workers.dev or preview URL must be disabled");
const settings = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/settings");
const bindings = settings.bindings || [];
for (const [name, service] of [["IDENTITY", "lifespace-identity-staging"], ["CORE", "lifespace-core-staging"]]) {
  assert(bindings.some(b => b.name === name && b.type === "service" && b.service === service),
    "Missing Staging-only Service Binding " + name);
}
const models = bindings.find(b => b.name === "MCP_MODEL_KEYS" && b.type === "plain_text");
assert(models && typeof models.text === "string"
  && models.text.split(",").every(k => ["task", "event"].includes(k.trim()))
  && models.text.split(",").length >= 1,
  "MCP model allowlist exceeds approved Staging task/event scope");
const domains = await cloudflare("/accounts/" + accountId + "/workers/domains");
assert(Array.isArray(domains) && domains.some(d => d.hostname === hostname
  && d.service === workerName && d.enabled === true && d.previews_enabled !== true),
  "MCP Staging custom domain is not attached");

const installed = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets");
assert(Array.isArray(installed), "Cannot inspect Worker secret metadata");
const existing = installed.some(s => s.name === "LIFESPACE_APPLICATION_CREDENTIAL");
assert((existing && action === "ROTATE_MCP_STAGING") || (!existing && action === "INSTALL_MCP_STAGING"),
  existing ? "Credential already installed; explicit ROTATE_MCP_STAGING is required"
    : "No credential installed; use INSTALL_MCP_STAGING");

// This is the *only* mutation. The one-time credential comes from a protected
// GitHub Staging Environment Secret, not a workflow input or debug output.
await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets", {
  method: "PUT",
  body: { type: "secret_text", name: "LIFESPACE_APPLICATION_CREDENTIAL", text: appCredential },
});
const after = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets");
assert(Array.isArray(after) && after.some(s => s.name === "LIFESPACE_APPLICATION_CREDENTIAL"),
  "The MCP Worker credential installation was not confirmed");

console.log(JSON.stringify({
  success: true, environment: "staging",
  applicationIdVerified: true, applicationIdSource: idSource, readOnlyScopeVerified: true,
  managedOAuthConfigured: true, workerSecretInstalled: true,
  // Audience association remains a privileged Console operation, not asserted here.
  audienceRegistered: "must_be_confirmed_in_lifespace_console",
  modelReadAccess: "must_be_confirmed_in_lifespace_console",
  credentialRotated: existing, productionTouched: false,
}));

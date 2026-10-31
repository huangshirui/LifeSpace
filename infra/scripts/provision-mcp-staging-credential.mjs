// Explicit owner-only staging provisioning. No user credentials, audiences or secrets
// are committed to source, returned in logs, or reused from other Applications.
const identityBase = "https://auth-staging.aisr.online";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const cfToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const bootstrap = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const applicationId = "app_lifespace_mcp_staging";
const applicationName = "LifeSpace MCP Staging";
const hostname = "mcp-staging.aisr.online";
const workerName = "lifespace-mcp-staging";
const allowedScopes = ["resources:read"];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
assert(/^[0-9a-f]{32}$/u.test(accountId), "Staging Cloudflare account ID missing or malformed");
assert(cfToken.length >= 20, "Staging Cloudflare API token missing");
assert(bootstrap.length >= 32, "Staging bootstrap secret missing");

async function request(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: "application/json", ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(20000),
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
async function identity(path, options = {}) {
  return request(identityBase + path, {
    ...options, headers: { "x-bootstrap-secret": bootstrap, ...options.headers },
  });
}

const status = await request(identityBase + "/api/v1/status");
assert(status.status === 200 && status.payload?.data?.environment === "staging",
  "Refusing to provision a non-staging LifeSpace Identity environment");

// Verify that the exact destination has a Managed OAuth Access application
// with narrow test-user allow rules; never replace an existing Access policy.
const apps = await cloudflare("/accounts/" + accountId + "/access/apps?domain=" + encodeURIComponent(hostname) + "&exact=true");
assert(Array.isArray(apps), "Access application listing is not an array");
const app = apps.find(a => a.domain === hostname && a.name === applicationName);
assert(app && apps.filter(a => a.domain === hostname).length === 1,
  "MCP staging Access application is missing or ambiguous");
const access = await cloudflare("/accounts/" + accountId + "/access/apps/" + encodeURIComponent(app.id));
assert(access.type === "self_hosted" && access.oauth_configuration?.enabled === true
  && typeof access.aud === "string" && access.aud.length >= 20,
  "MCP Access application must be self-hosted with Managed OAuth enabled");
const policies = await cloudflare("/accounts/" + accountId + "/access/apps/" + encodeURIComponent(app.id) + "/policies");
assert(Array.isArray(policies) && policies.length === 1 && policies[0].decision === "allow"
  && Array.isArray(policies[0].include) && policies[0].include.length > 0
  && policies[0].include.every(rule => Object.keys(rule).length === 1 && !!rule.email?.email)
  && !(policies[0].exclude?.length) && !(policies[0].require?.length),
  "MCP OAuth Access policy must allow only explicitly listed tester emails");

// The Worker must be unreachable through workers.dev and must use only Staging services.
const subdomain = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/subdomain");
assert(subdomain.enabled !== true && subdomain.previews_enabled !== true,
  "MCP Worker workers.dev or preview URL must be disabled");
const settings = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/settings");
const bindings = settings.bindings || [];
for (const [name, service] of [["IDENTITY", "lifespace-identity-staging"], ["CORE", "lifespace-core-staging"]]) {
  assert(bindings.some(b => b.name === name && b.type === "service" && b.service === service),
    "Missing Staging-only Service Binding " + name);
}
assert(bindings.some(b => b.name === "MCP_MODEL_KEYS" && b.type === "plain_text"),
  "MCP model allowlist is not configured");
const domains = await cloudflare("/accounts/" + accountId + "/workers/domains");
assert(Array.isArray(domains) && domains.some(d => d.hostname === hostname
  && d.service === workerName && d.enabled === true && d.previews_enabled !== true),
  "MCP Staging Worker Custom Domain is not attached");

// Identity is the only authority for Application, Access Audience and User Token exchange.
const applicationPath = "/bootstrap/v1/applications/" + encodeURIComponent(applicationId);
const before = await identity(applicationPath);
let oneTimeCredential;
let createdApplication = false;
if (before.status === 404) {
  const created = await identity("/bootstrap/v1/applications", {
    method: "POST",
    body: { id: applicationId, name: applicationName, allowedScopes,
      trustedBackend: true, accessTokenTtlSeconds: 600 },
  });
  assert(created.status === 201 && created.payload?.data?.id === applicationId,
    "LifeSpace MCP Application creation was rejected");
  oneTimeCredential = created.payload.data.clientSecret;
  createdApplication = true;
} else {
  assert(before.status === 200 && before.payload?.data?.id === applicationId,
    "LifeSpace MCP Application lookup failed");
  const value = before.payload.data;
  assert(value.name === applicationName && value.trustedBackend === true
    && value.status === "active" && value.accessTokenTtlSeconds === 600
    && Array.isArray(value.allowedScopes) && value.allowedScopes.length === 1
    && value.allowedScopes[0] === allowedScopes[0],
    "Existing MCP Application has incompatible or excessive permissions");
}
const audiencePath = applicationPath + "/access-audiences";
const registered = await identity(audiencePath);
assert(registered.status === 200 && Array.isArray(registered.payload?.data),
  "Cannot list current Access audience registrations");
if (!registered.payload.data.some(row => row.audience === access.aud && row.status === "active")) {
  const added = await identity(audiencePath, {
    method: "POST", body: { audience: access.aud },
  });
  assert([200, 201].includes(added.status) && added.payload?.data?.audience === access.aud,
    "Cannot register MCP Access Audience in LifeSpace Identity");
}

// Creation is idempotent after the secret is sealed into the Worker. Rotating a
// pre-existing credential is deliberately NOT an incidental repeat-run side effect.
const installed = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets");
assert(Array.isArray(installed), "Cannot list MCP Worker secret metadata");
const alreadySealed = installed.some(s => s.name === "LIFESPACE_APPLICATION_CREDENTIAL");
if (!alreadySealed) {
  if (!oneTimeCredential) {
    const fresh = await identity(applicationPath + "/credentials", { method: "POST" });
    assert(fresh.status === 201, "LifeSpace MCP credential issuance failed");
    oneTimeCredential = fresh.payload?.data?.clientSecret;
  }
  assert(typeof oneTimeCredential === "string" && oneTimeCredential.startsWith("lsa_"),
    "Identity returned invalid one-time Application credential");
  await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets", {
    method: "PUT", body: {
      type: "secret_text", name: "LIFESPACE_APPLICATION_CREDENTIAL",
      text: oneTimeCredential,
    },
  });
  oneTimeCredential = undefined;
}
const after = await cloudflare("/accounts/" + accountId + "/workers/scripts/" + workerName + "/secrets");
assert(after.some(s => s.name === "LIFESPACE_APPLICATION_CREDENTIAL"),
  "MCP Worker has no sealed LifeSpace Application credential");
console.log(JSON.stringify({
  success: true, environment: "staging", createdApplication,
  managedOAuthConfigured: true, accessAudienceRegistered: true,
  applicationScopeCeiling: allowedScopes, workerSecretConfigured: true,
  productionTouched: false,
  // Core Application × Model Access remains a separate human-admin action.
  next: "Set task/event to read for the MCP Application in Staging Console; run live ChatGPT MCP acceptance",
}));

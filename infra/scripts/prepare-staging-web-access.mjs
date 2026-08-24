import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const accessAudience = (process.env.LIFESPACE_STAGING_ACCESS_AUD ?? "").trim();
const applicationId = (process.env.LIFESPACE_STAGING_WEB_APPLICATION_ID ?? "app_homemew_web_staging").trim();
const applicationName = (process.env.LIFESPACE_STAGING_WEB_APPLICATION_NAME ?? "HomeMew Web staging").trim();
const credentialOutput = (process.env.LIFESPACE_STAGING_WEB_CREDENTIAL_OUTPUT ?? "").trim();
const githubEnv = (process.env.GITHUB_ENV ?? "").trim();

const REQUIRED_CONTRACT = "0.5.0";
const REQUIRED_SCHEMA = "5";
const TOKEN_TTL_SECONDS = 900;
const APPLICATION_SCOPES = [
  "profile:read",
  "profile:write",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "grants:manage",
  "resources:read",
  "resources:write",
  "creation-drafts:read",
  "creation-drafts:write",
];

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_ACCESS_AUD: accessAudience,
  LIFESPACE_STAGING_WEB_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_WEB_APPLICATION_NAME: applicationName,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) {
  throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
}
if (/\s/u.test(accessAudience)) {
  throw new Error("LIFESPACE_STAGING_ACCESS_AUD must not contain whitespace");
}
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) {
  throw new Error("LIFESPACE_STAGING_WEB_APPLICATION_ID must use an app_* identifier");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sameStringArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

async function jsonRequest(path, { method = "GET", bootstrap = false, body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

function secureCredentialSinkAvailable() {
  return Boolean(githubEnv || credentialOutput);
}

function persistCredential(clientSecret) {
  if (typeof clientSecret !== "string" || !clientSecret.startsWith("lsa_")) {
    throw new Error("Identity did not return a valid application credential");
  }
  mask(clientSecret);

  if (githubEnv) {
    if (clientSecret.includes("\n") || clientSecret.includes("\r")) {
      throw new Error("Generated application credential cannot contain newlines");
    }
    appendFileSync(githubEnv, `LIFESPACE_STAGING_WEB_APPLICATION_CREDENTIAL=${clientSecret}\n`, "utf8");
    return { destination: "GITHUB_ENV" };
  }

  if (credentialOutput) {
    writeFileSync(credentialOutput, `${JSON.stringify({ applicationId, clientSecret }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try { chmodSync(credentialOutput, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
    return { destination: credentialOutput };
  }

  throw new Error("No secure credential sink is configured");
}

async function requireIdentity05() {
  const status = await jsonRequest("/api/v1/status");
  const data = status.payload?.data;
  if (status.response.status !== 200) {
    throw new Error(`Identity staging status failed: ${status.response.status} ${JSON.stringify(status.payload)}`);
  }
  if (String(data?.schemaVersion) !== REQUIRED_SCHEMA || data?.contractVersion !== REQUIRED_CONTRACT) {
    throw new Error(
      `Identity staging must be schema v${REQUIRED_SCHEMA} / contract ${REQUIRED_CONTRACT} before Web Access provisioning; `
      + `found schema ${String(data?.schemaVersion ?? "unknown")} / contract ${String(data?.contractVersion ?? "unknown")}`,
    );
  }
  if (data?.environment !== "staging") {
    throw new Error(`Refusing to provision a non-staging Identity environment: ${String(data?.environment ?? "unknown")}`);
  }
  return data;
}

async function loadApplication() {
  return jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: true });
}

async function createApplication() {
  if (!secureCredentialSinkAvailable()) {
    throw new Error(
      "HomeMew Web staging application does not exist. Initial trusted-app creation returns an lsa_* exactly once, so set "
      + "GITHUB_ENV (GitHub Actions) or LIFESPACE_STAGING_WEB_CREDENTIAL_OUTPUT to a new temporary file before rerunning.",
    );
  }

  const result = await jsonRequest("/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: true,
    body: {
      id: applicationId,
      name: applicationName,
      clientType: "web",
      allowedScopes: APPLICATION_SCOPES,
      trustedBackend: true,
      accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
    },
  });
  if (result.response.status !== 201 || result.payload?.data?.id !== applicationId) {
    throw new Error(`Web application creation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  const credential = persistCredential(result.payload?.data?.clientSecret);
  return { created: true, credential };
}

async function reconcileApplication(existing) {
  if (existing.clientType !== "web" || existing.trustedBackend !== true) {
    throw new Error(
      `Existing application ${applicationId} has immutable clientType/trustedBackend incompatible with Access Web: `
      + `${JSON.stringify({ clientType: existing.clientType, trustedBackend: existing.trustedBackend })}`,
    );
  }

  const patch = {};
  if (existing.name !== applicationName) patch.name = applicationName;
  if (!sameStringArray(existing.allowedScopes, APPLICATION_SCOPES)) patch.allowedScopes = APPLICATION_SCOPES;
  if (existing.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) patch.accessTokenTtlSeconds = TOKEN_TTL_SECONDS;
  if (existing.status !== "active") patch.status = "active";

  if (Object.keys(patch).length) {
    const result = await jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
      method: "PATCH",
      bootstrap: true,
      body: patch,
    });
    if (result.response.status !== 200) {
      throw new Error(`Web application reconciliation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    return { updated: true, application: result.payload?.data };
  }
  return { updated: false, application: existing };
}

async function ensureActiveCredential() {
  const list = await jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, { bootstrap: true });
  if (list.response.status !== 200 || !Array.isArray(list.payload?.data)) {
    throw new Error(`Application credential listing failed: ${list.response.status} ${JSON.stringify(list.payload)}`);
  }
  const active = list.payload.data.filter((entry) => entry?.status === "active" && entry?.revokedAt == null);
  if (active.length) return { activeCredentialCount: active.length, credentialCreated: false };

  if (!secureCredentialSinkAvailable()) {
    throw new Error(
      `Application ${applicationId} has no active credential. Set GITHUB_ENV or LIFESPACE_STAGING_WEB_CREDENTIAL_OUTPUT `
      + "before rerunning so the one-time replacement lsa_* can be stored securely.",
    );
  }
  const created = await jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, {
    method: "POST",
    bootstrap: true,
  });
  if (created.response.status !== 201) {
    throw new Error(`Application credential creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  const credential = persistCredential(created.payload?.data?.clientSecret);
  return { activeCredentialCount: 1, credentialCreated: true, credential };
}

async function ensureAudience() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/access-audiences`;
  const before = await jsonRequest(path, { bootstrap: true });
  if (before.response.status !== 200 || !Array.isArray(before.payload?.data)) {
    throw new Error(
      `Access audience listing failed. Confirm Identity 0.5.0 is deployed and ACCESS_TEAM_DOMAIN is configured: `
      + `${before.response.status} ${JSON.stringify(before.payload)}`,
    );
  }

  const existing = before.payload.data.find((entry) => entry?.audience === accessAudience && entry?.status === "active");
  if (existing) return { created: false, audience: existing };

  const created = await jsonRequest(path, {
    method: "POST",
    bootstrap: true,
    body: { audience: accessAudience },
  });
  if (![200, 201].includes(created.response.status) || created.payload?.data?.audience !== accessAudience) {
    throw new Error(
      `Access audience registration failed. If the error is ACCESS_NOT_CONFIGURED, configure ACCESS_TEAM_DOMAIN on Identity staging; `
      + `if it is ACCESS_AUDIENCE_IN_USE, the AUD is already bound to another LifeSpace application: `
      + `${created.response.status} ${JSON.stringify(created.payload)}`,
    );
  }
  return { created: created.response.status === 201, audience: created.payload.data };
}

const identity = await requireIdentity05();
let applicationResult = await loadApplication();
let applicationCreated = false;
let credentialFromInitialCreation = null;

if (applicationResult.response.status === 404) {
  const created = await createApplication();
  applicationCreated = true;
  credentialFromInitialCreation = created.credential;
  applicationResult = await loadApplication();
}
if (applicationResult.response.status !== 200 || applicationResult.payload?.data?.id !== applicationId) {
  throw new Error(`Application lookup failed: ${applicationResult.response.status} ${JSON.stringify(applicationResult.payload)}`);
}

const reconciled = await reconcileApplication(applicationResult.payload.data);
const credentialState = await ensureActiveCredential();
const audienceState = await ensureAudience();

console.log(JSON.stringify({
  ok: true,
  identity: {
    environment: identity.environment,
    schemaVersion: identity.schemaVersion,
    contractVersion: identity.contractVersion,
  },
  application: {
    id: applicationId,
    name: applicationName,
    created: applicationCreated,
    updated: reconciled.updated,
    clientType: "web",
    trustedBackend: true,
    accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
    allowedScopes: APPLICATION_SCOPES,
  },
  credential: {
    activeCount: credentialState.activeCredentialCount,
    created: Boolean(credentialFromInitialCreation || credentialState.credentialCreated),
    destination: credentialFromInitialCreation?.destination ?? credentialState.credential?.destination ?? null,
  },
  accessAudience: {
    audience: accessAudience,
    issuer: audienceState.audience?.issuer ?? null,
    created: audienceState.created,
    status: audienceState.audience?.status ?? null,
  },
}, null, 2));

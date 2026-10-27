import { appendFileSync } from "node:fs";
import process from "node:process";
import { STAGING_EXPECTATIONS, assertStagingServiceUrl } from "./staging-expectations.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const accessAudience = (process.env.LIFESPACE_STAGING_CONSOLE_ACCESS_AUD ?? "").trim();
const applicationId = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_ID ?? "app_lifespace_console_staging").trim();
const applicationName = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_NAME ?? "LifeSpace Console staging").trim();
const githubEnv = (process.env.GITHUB_ENV ?? "").trim();

const TOKEN_TTL_SECONDS = 900;
const APPLICATION_SCOPES = [
  "profile:read",
  "spaces:manage",
  "platform:admin",
  "applications:manage",
  "services:manage",
  "identities:read",
  "models:manage",
  "spaces:inspect",
  "audit:read",
];

assertStagingServiceUrl(identityBase, "identity");

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_CONSOLE_ACCESS_AUD: accessAudience,
  LIFESPACE_STAGING_CONSOLE_APPLICATION_ID: applicationId,
  GITHUB_ENV: githubEnv,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (/\s/u.test(accessAudience)) throw new Error("LIFESPACE_STAGING_CONSOLE_ACCESS_AUD must not contain whitespace");
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) throw new Error("LIFESPACE_STAGING_CONSOLE_APPLICATION_ID must use an app_* identifier");

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}
mask(bootstrapSecret);

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      "x-bootstrap-secret": bootstrapSecret,
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

function persistCredential(value) {
  if (typeof value !== "string" || !value.startsWith("lsa_")) throw new Error("Identity did not return a valid Console application credential");
  if (value.includes("\n") || value.includes("\r")) throw new Error("Generated application credential contains a newline");
  mask(value);
  appendFileSync(githubEnv, `LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL=${value}\n`, "utf8");
  return value;
}

async function requireIdentityConvergence() {
  const response = await fetch(`${identityBase}/api/v1/status`, { headers: { accept: "application/json" } });
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  if (
    response.status !== 200
    || data?.environment !== "staging"
    || String(data?.schemaVersion) !== String(STAGING_EXPECTATIONS.identity.schemaVersion)
    || data?.contractVersion !== STAGING_EXPECTATIONS.identity.contractVersion
  ) {
    throw new Error(
      `Identity staging must match schema v${STAGING_EXPECTATIONS.identity.schemaVersion} / contract ${STAGING_EXPECTATIONS.identity.contractVersion}; `
      + `found ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return data;
}

async function loadApplication() {
  return request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`);
}

async function createApplication() {
  const created = await request("/bootstrap/v1/applications", {
    method: "POST",
    body: {
      id: applicationId,
      name: applicationName,
      allowedScopes: APPLICATION_SCOPES,
      trustedBackend: true,
      accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
    },
  });
  if (created.response.status !== 201 || created.payload?.data?.id !== applicationId) {
    throw new Error(`Console application creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  return { application: created.payload.data, credential: persistCredential(created.payload.data.clientSecret), created: true };
}

function requireExistingApplicationPolicy(existing) {
  // This session-only workflow is for Access entry setup, not for restoring
  // a disabled Console or widening existing Application authority.
  const mismatches = [];
  if (existing.trustedBackend !== true) mismatches.push("trustedBackend");
  if (existing.name !== applicationName) mismatches.push("name");
  if (!sameStringSet(existing.allowedScopes, APPLICATION_SCOPES)) mismatches.push("allowedScopes");
  if (existing.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) mismatches.push("accessTokenTtlSeconds");
  if (existing.status !== "active") mismatches.push("status");
  if (mismatches.length) {
    throw new Error(
      `Existing Console Application policy differs (${mismatches.join(", ")}); session-only provisioning will not change it. `
      + "Use the explicitly authorized Console Platform Admin configuration or the full staging Console provisioning path for a deliberate change.",
    );
  }
  return existing;
}

async function rotateApplicationCredential() {
  const created = await request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, { method: "POST" });
  if (created.response.status !== 201) {
    throw new Error(`Console application credential rotation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  return persistCredential(created.payload?.data?.clientSecret);
}

async function ensureAudience() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/access-audiences`;
  const listed = await request(path);
  if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
    throw new Error(`Console Access audience listing failed: ${listed.response.status} ${JSON.stringify(listed.payload)}`);
  }
  const current = listed.payload.data.find((entry) => entry?.audience === accessAudience && entry?.status === "active");
  if (current) return { created: false, audience: current };

  const created = await request(path, { method: "POST", body: { audience: accessAudience } });
  if (![200, 201].includes(created.response.status) || created.payload?.data?.audience !== accessAudience) {
    throw new Error(`Console Access audience registration failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  return { created: created.response.status === 201, audience: created.payload.data };
}

const identity = await requireIdentityConvergence();
let lookup = await loadApplication();
let created = false;
let application;
let credential;

if (lookup.response.status === 404) {
  const result = await createApplication();
  application = result.application;
  credential = result.credential;
  created = true;
} else {
  if (lookup.response.status !== 200 || lookup.payload?.data?.id !== applicationId) {
    throw new Error(`Console application lookup failed: ${lookup.response.status} ${JSON.stringify(lookup.payload)}`);
  }
  application = requireExistingApplicationPolicy(lookup.payload.data);
  credential = await rotateApplicationCredential();
}

const audience = await ensureAudience();

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  identity: { contractVersion: identity.contractVersion, schemaVersion: identity.schemaVersion },
  application: {
    id: applicationId,
    name: applicationName,
    created,
    allowedScopes: APPLICATION_SCOPES,
    credentialRotated: true,
    existingPolicyUnchanged: !created,
    plaintextLogged: false,
  },
  accessAudience: {
    audience: accessAudience,
    issuer: audience.audience?.issuer ?? null,
    status: audience.audience?.status ?? null,
    created: audience.created,
  },
  sessionOnly: true,
  administratorAssigned: false,
  coreExecutorProvisioned: false,
  productionTouched: false,
}, null, 2));

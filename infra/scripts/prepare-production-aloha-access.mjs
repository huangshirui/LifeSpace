import { chmodSync, writeFileSync } from "node:fs";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const accessAudience = (process.env.LIFESPACE_PRODUCTION_ALOHA_ACCESS_AUD ?? "").trim();
const applicationId = (process.env.LIFESPACE_PRODUCTION_ALOHA_APPLICATION_ID ?? "aloha-assistant").trim();
const applicationName = (process.env.LIFESPACE_PRODUCTION_ALOHA_APPLICATION_NAME ?? "ALOHA Assistant").trim();
const suppliedCredential = (process.env.LIFESPACE_PRODUCTION_ALOHA_APPLICATION_CREDENTIAL ?? "").trim();
const credentialOutput = (process.env.LIFESPACE_PRODUCTION_ALOHA_CREDENTIAL_OUTPUT ?? "").trim();

const REQUIRED_CONTRACT = "0.6.0";
const MINIMUM_SCHEMA = 8;
const TOKEN_TTL_SECONDS = 900;
const APPLICATION_SCOPES = ["profile:read"];
const AGENT_DISPLAY_NAME = "ALOHA Assistant";

for (const [name, value] of Object.entries({
  LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_PRODUCTION_ALOHA_ACCESS_AUD: accessAudience,
  LIFESPACE_PRODUCTION_ALOHA_APPLICATION_ID: applicationId,
  LIFESPACE_PRODUCTION_ALOHA_APPLICATION_NAME: applicationName,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) {
  throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
}
if (/\s/u.test(accessAudience)) {
  throw new Error("LIFESPACE_PRODUCTION_ALOHA_ACCESS_AUD must not contain whitespace");
}
if (suppliedCredential && (!suppliedCredential.startsWith("lsa_") || suppliedCredential.length < 40)) {
  throw new Error("LIFESPACE_PRODUCTION_ALOHA_APPLICATION_CREDENTIAL is not a valid lsa_* credential");
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

async function jsonRequest(path, { method = "GET", bootstrap = false, bearer = "", body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
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

function persistCredential(clientSecret) {
  if (typeof clientSecret !== "string" || !clientSecret.startsWith("lsa_")) {
    throw new Error("Identity did not return a valid application credential");
  }
  if (!credentialOutput) {
    throw new Error(
      "A new lsa_* must be stored exactly once. Set LIFESPACE_PRODUCTION_ALOHA_CREDENTIAL_OUTPUT to a new temporary file outside the repository.",
    );
  }
  mask(clientSecret);
  writeFileSync(credentialOutput, `${JSON.stringify({ applicationId, clientSecret }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try { chmodSync(credentialOutput, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  return credentialOutput;
}

async function requireProductionIdentity06() {
  const status = await jsonRequest("/api/v1/status");
  const data = status.payload?.data;
  if (status.response.status !== 200) {
    throw new Error(`Identity production status failed with HTTP ${status.response.status}`);
  }
  const schemaVersion = Number(data?.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < MINIMUM_SCHEMA || data?.contractVersion !== REQUIRED_CONTRACT) {
    throw new Error(
      `Identity production must be schema v${MINIMUM_SCHEMA}+ / contract ${REQUIRED_CONTRACT}; `
      + `found schema ${String(data?.schemaVersion ?? "unknown")} / contract ${String(data?.contractVersion ?? "unknown")}`,
    );
  }
  if (data?.environment !== "production") {
    throw new Error(`Refusing to provision a non-production Identity environment: ${String(data?.environment ?? "unknown")}`);
  }
  return data;
}

async function loadApplication() {
  return jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: true });
}

async function createApplication() {
  if (!credentialOutput) {
    throw new Error(
      "ALOHA production application does not exist. Initial trusted-app creation returns an lsa_* exactly once; set "
      + "LIFESPACE_PRODUCTION_ALOHA_CREDENTIAL_OUTPUT to a new temporary file outside the repository before rerunning.",
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
    throw new Error(`ALOHA application creation failed with HTTP ${result.response.status}`);
  }
  const clientSecret = result.payload?.data?.clientSecret;
  const destination = persistCredential(clientSecret);
  return { clientSecret, destination };
}

async function reconcileApplication(existing) {
  if (existing.clientType !== "web" || existing.trustedBackend !== true) {
    throw new Error(
      `Existing application ${applicationId} has incompatible immutable trust class: `
      + `${JSON.stringify({ clientType: existing.clientType, trustedBackend: existing.trustedBackend })}`,
    );
  }
  const patch = {};
  if (existing.name !== applicationName) patch.name = applicationName;
  if (!sameStringArray(existing.allowedScopes, APPLICATION_SCOPES)) patch.allowedScopes = APPLICATION_SCOPES;
  if (existing.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) patch.accessTokenTtlSeconds = TOKEN_TTL_SECONDS;
  if (existing.status !== "active") patch.status = "active";
  if (!Object.keys(patch).length) return false;

  const result = await jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
    method: "PATCH",
    bootstrap: true,
    body: patch,
  });
  if (result.response.status !== 200) {
    throw new Error(`ALOHA application reconciliation failed with HTTP ${result.response.status}`);
  }
  return true;
}

async function resolveApplicationCredential(initialCredential) {
  if (initialCredential) return { clientSecret: initialCredential, created: true };
  if (suppliedCredential) return { clientSecret: suppliedCredential, created: false };

  const listed = await jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, { bootstrap: true });
  if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
    throw new Error(`ALOHA application credential listing failed with HTTP ${listed.response.status}`);
  }
  const active = listed.payload.data.filter((entry) => entry?.status === "active" && entry?.revokedAt == null);
  if (active.length > 0) {
    throw new Error(
      `Application ${applicationId} already has ${active.length} active credential(s), but plaintext cannot be recovered. `
      + "Provide the deployment credential through LIFESPACE_PRODUCTION_ALOHA_APPLICATION_CREDENTIAL; do not rotate implicitly.",
    );
  }
  if (!credentialOutput) {
    throw new Error(
      "Application has no active credential. Set LIFESPACE_PRODUCTION_ALOHA_CREDENTIAL_OUTPUT to a new temporary file before rerunning.",
    );
  }
  const created = await jsonRequest(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, {
    method: "POST",
    bootstrap: true,
  });
  if (created.response.status !== 201) {
    throw new Error(`ALOHA application credential creation failed with HTTP ${created.response.status}`);
  }
  const clientSecret = created.payload?.data?.clientSecret;
  persistCredential(clientSecret);
  return { clientSecret, created: true };
}

async function ensureAudience() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/access-audiences`;
  const listed = await jsonRequest(path, { bootstrap: true });
  if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
    throw new Error(`ALOHA Access audience listing failed with HTTP ${listed.response.status}`);
  }
  const existing = listed.payload.data.find((entry) => entry?.audience === accessAudience && entry?.status === "active");
  if (existing) return false;

  const created = await jsonRequest(path, {
    method: "POST",
    bootstrap: true,
    body: { audience: accessAudience },
  });
  if (![200, 201].includes(created.response.status) || created.payload?.data?.audience !== accessAudience) {
    const code = created.payload?.error?.code;
    throw new Error(
      `ALOHA Access audience registration failed with HTTP ${created.response.status}${code ? ` (${code})` : ""}. `
      + "Do not reassign an AUD already owned by another application.",
    );
  }
  return created.response.status === 201;
}

async function ensureSingleAgent(applicationCredential) {
  const listed = await jsonRequest("/internal/v1/agents", { bearer: applicationCredential });
  const items = listed.payload?.data?.items;
  if (listed.response.status !== 200 || !Array.isArray(items)) {
    throw new Error(`ALOHA Agent listing failed with HTTP ${listed.response.status}; verify the supplied lsa_* belongs to ${applicationId}`);
  }
  const active = items.filter((entry) => entry?.status === "active");
  if (active.length > 1) {
    throw new Error(`ALOHA requires exactly one active Agent for ${applicationId}; found ${active.length}. Resolve the ambiguity explicitly.`);
  }
  if (active.length === 1) return { created: false, agentId: active[0]?.id };

  const created = await jsonRequest("/internal/v1/agents", {
    method: "POST",
    bearer: applicationCredential,
    body: { displayName: AGENT_DISPLAY_NAME },
  });
  if (created.response.status !== 201 || typeof created.payload?.data?.id !== "string") {
    throw new Error(`ALOHA Agent creation failed with HTTP ${created.response.status}`);
  }
  return { created: true, agentId: created.payload.data.id };
}

const identity = await requireProductionIdentity06();
let application = await loadApplication();
let applicationCreated = false;
let initialCredential = "";
let credentialDestination = null;

if (application.response.status === 404) {
  const created = await createApplication();
  applicationCreated = true;
  initialCredential = created.clientSecret;
  credentialDestination = created.destination;
  application = await loadApplication();
}
if (application.response.status !== 200 || application.payload?.data?.id !== applicationId) {
  throw new Error(`ALOHA application lookup failed with HTTP ${application.response.status}`);
}

const applicationUpdated = await reconcileApplication(application.payload.data);
const credential = await resolveApplicationCredential(initialCredential);
mask(credential.clientSecret);
const audienceCreated = await ensureAudience();
const agent = await ensureSingleAgent(credential.clientSecret);

console.log(JSON.stringify({
  ok: true,
  identity: {
    environment: identity.environment,
    schemaVersion: identity.schemaVersion,
    contractVersion: identity.contractVersion,
  },
  application: {
    id: applicationId,
    created: applicationCreated,
    updated: applicationUpdated,
    clientType: "web",
    trustedBackend: true,
    allowedScopes: APPLICATION_SCOPES,
    accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
  },
  credential: {
    created: credential.created,
    destination: credentialDestination ?? (credential.created ? credentialOutput : null),
  },
  accessAudience: {
    registered: true,
    created: audienceCreated,
  },
  agent: {
    configured: true,
    created: agent.created,
    id: agent.agentId,
  },
  next: "Install the lsa_* from the secure sink as ALOHA Agent Control LIFESPACE_APPLICATION_CREDENTIAL, then run the M3 Access-authenticated deployment verifier.",
}, null, 2));

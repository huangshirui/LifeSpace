import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";
import process from "node:process";
import { STAGING_EXPECTATIONS, assertStagingServiceUrl } from "./staging-expectations.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const accessAudience = (process.env.LIFESPACE_STAGING_CONSOLE_ACCESS_AUD ?? "").trim();
const applicationId = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_ID ?? "app_lifespace_console_staging").trim();
const applicationName = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_NAME ?? "LifeSpace Console staging").trim();
const platformAdminUserId = (process.env.LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID ?? "").trim();
const suppliedApplicationCredential = (process.env.LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL ?? "").trim();
const suppliedCoreBearer = (process.env.LIFESPACE_STAGING_CONSOLE_CORE_BEARER ?? "").trim();
const rotateCredentials = process.env.LIFESPACE_STAGING_CONSOLE_ROTATE_CREDENTIALS === "1";
const recoverPlatformAdmin = process.env.LIFESPACE_STAGING_CONSOLE_RECOVER_PLATFORM_ADMIN === "1";
const credentialOutput = (process.env.LIFESPACE_STAGING_CONSOLE_CREDENTIAL_OUTPUT ?? "").trim();
const githubEnv = (process.env.GITHUB_ENV ?? "").trim();

const TOKEN_TTL_SECONDS = 900;
const APPLICATION_SCOPES = [
  "profile:read",
  "spaces:manage",
  "grants:manage",
  "platform:admin",
  "applications:manage",
  "services:manage",
  "identities:read",
  "models:manage",
  "spaces:inspect",
  "audit:read",
];
const CORE_EXECUTOR_SCOPES = [
  "applications:manage",
  "models:manage",
  "spaces:inspect",
  "spaces:manage",
  "grants:manage",
  "audit:read",
];
const CORE_EXECUTOR_NAME = "LifeSpace Console Core executor (staging)";
const CORE_EXECUTOR_DESCRIPTION = "Dedicated staging-only Core control-plane executor for LifeSpace Console";
const CORE_TOKEN_LABEL = "LifeSpace Console staging Core executor";

assertStagingServiceUrl(identityBase, "identity");
assertStagingServiceUrl(coreBase, "core");

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_CONSOLE_ACCESS_AUD: accessAudience,
  LIFESPACE_STAGING_CONSOLE_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID: platformAdminUserId,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (/\s/u.test(accessAudience)) throw new Error("LIFESPACE_STAGING_CONSOLE_ACCESS_AUD must not contain whitespace");
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) throw new Error("LIFESPACE_STAGING_CONSOLE_APPLICATION_ID must use an app_* identifier");
if (!/^usr_[0-9A-Za-z_-]+$/u.test(platformAdminUserId)) throw new Error("LIFESPACE_STAGING_PLATFORM_ADMIN_USER_ID must use a usr_* identifier");
if (suppliedApplicationCredential && !suppliedApplicationCredential.startsWith("lsa_")) {
  throw new Error("LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL must be an lsa_* credential");
}
if (suppliedCoreBearer && !suppliedCoreBearer.startsWith("lsp_svc_") && !suppliedCoreBearer.startsWith("lsp_pat_") && suppliedCoreBearer.split(".").length !== 3) {
  throw new Error("LIFESPACE_STAGING_CONSOLE_CORE_BEARER must be an lsp_svc_*/legacy lsp_pat_* token or service JWT");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}
mask(bootstrapSecret);
mask(suppliedApplicationCredential);
mask(suppliedCoreBearer);

if (credentialOutput && existsSync(credentialOutput)) {
  throw new Error(`Refusing to overwrite existing credential output file: ${credentialOutput}`);
}
if (credentialOutput) {
  writeFileSync(credentialOutput, "", { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { chmodSync(credentialOutput, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
}

function secureSinkAvailable() {
  return Boolean(githubEnv || credentialOutput);
}

function persistSecret(name, value) {
  if (typeof value !== "string" || !value) throw new Error(`${name} was not returned as a non-empty secret`);
  if (value.includes("\n") || value.includes("\r")) throw new Error(`${name} contains an invalid newline`);
  mask(value);
  if (githubEnv) appendFileSync(githubEnv, `${name}=${value}\n`, "utf8");
  if (credentialOutput) appendFileSync(credentialOutput, `${name}=${value}\n`, { encoding: "utf8", mode: 0o600 });
  if (!githubEnv && !credentialOutput) throw new Error(`No secure credential sink is configured for ${name}`);
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

async function request(base, path, { method = "GET", bootstrap = false, bearer = "", actor = "", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(actor ? { "x-lifespace-actor-token": actor } : {}),
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

async function requireStagingConvergence() {
  const [identity, core] = await Promise.all([
    request(identityBase, "/api/v1/status"),
    request(coreBase, "/api/v1/status"),
  ]);
  const identityData = identity.payload?.data;
  const coreData = core.payload?.data;
  if (
    identity.response.status !== 200
    || identityData?.environment !== "staging"
    || String(identityData?.schemaVersion) !== String(STAGING_EXPECTATIONS.identity.schemaVersion)
    || identityData?.contractVersion !== STAGING_EXPECTATIONS.identity.contractVersion
  ) {
    throw new Error(`Identity staging is not converged to schema v${STAGING_EXPECTATIONS.identity.schemaVersion} / contract ${STAGING_EXPECTATIONS.identity.contractVersion}: ${identity.response.status} ${JSON.stringify(identity.payload)}`);
  }
  if (
    core.response.status !== 200
    || coreData?.environment !== "staging"
    || String(coreData?.schemaVersion) !== String(STAGING_EXPECTATIONS.core.schemaVersion)
    || coreData?.contractVersion !== STAGING_EXPECTATIONS.core.contractVersion
  ) {
    throw new Error(`Core staging is not converged to schema v${STAGING_EXPECTATIONS.core.schemaVersion} / contract ${STAGING_EXPECTATIONS.core.contractVersion}: ${core.response.status} ${JSON.stringify(core.payload)}`);
  }
  return { identity: identityData, core: coreData };
}

async function loadApplication() {
  return request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, { bootstrap: true });
}

async function createApplication() {
  if (!secureSinkAvailable()) {
    throw new Error("Console staging application does not exist. Initial creation returns lsa_* exactly once; configure GITHUB_ENV or LIFESPACE_STAGING_CONSOLE_CREDENTIAL_OUTPUT first.");
  }
  const result = await request(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: true,
    body: {
      id: applicationId,
      name: applicationName,
      allowedScopes: APPLICATION_SCOPES,
      trustedBackend: true,
      accessTokenTtlSeconds: TOKEN_TTL_SECONDS,
    },
  });
  if (result.response.status !== 201 || result.payload?.data?.id !== applicationId) {
    throw new Error(`Console application creation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  const clientSecret = result.payload?.data?.clientSecret;
  if (typeof clientSecret !== "string" || !clientSecret.startsWith("lsa_")) throw new Error("Identity did not return the initial Console lsa_* credential");
  persistSecret("LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL", clientSecret);
  return clientSecret;
}

async function reconcileApplication(existing) {
  if (existing.trustedBackend !== true) {
    throw new Error(`Existing Console application ${applicationId} is not a trusted backend Application`);
  }
  const patch = {};
  if (existing.name !== applicationName) patch.name = applicationName;
  if (!sameStringSet(existing.allowedScopes, APPLICATION_SCOPES)) patch.allowedScopes = APPLICATION_SCOPES;
  if (existing.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS) patch.accessTokenTtlSeconds = TOKEN_TTL_SECONDS;
  if (existing.status !== "active") patch.status = "active";
  if (!Object.keys(patch).length) return { updated: false, application: existing };
  const result = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
    method: "PATCH",
    bootstrap: true,
    body: patch,
  });
  if (result.response.status !== 200) throw new Error(`Console application reconciliation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  return { updated: true, application: result.payload?.data };
}

async function createReplacementApplicationCredential(source) {
  if (!secureSinkAvailable()) throw new Error(`Console application credential ${source} requires GITHUB_ENV or LIFESPACE_STAGING_CONSOLE_CREDENTIAL_OUTPUT`);
  const created = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, {
    method: "POST",
    bootstrap: true,
  });
  if (created.response.status !== 201) throw new Error(`Console application credential creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  const clientSecret = created.payload?.data?.clientSecret;
  if (typeof clientSecret !== "string" || !clientSecret.startsWith("lsa_")) throw new Error("Identity did not return replacement Console lsa_*");
  persistSecret("LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL", clientSecret);
  return { credential: clientSecret, created: true, source };
}

async function ensureApplicationCredential(applicationCreated, initialSecret) {
  if (applicationCreated) return { credential: initialSecret, created: true, source: "initial-creation" };

  // Credential management is not a normal deploy preflight. Never list
  // unrelated credentials or implicitly mint a new one merely because
  // the plaintext was not passed to this run.
  if (rotateCredentials) return createReplacementApplicationCredential("rotation");
  if (suppliedApplicationCredential) return { credential: suppliedApplicationCredential, created: false, source: "environment" };

  throw new Error(
    "Existing Console application requires its installed LIFESPACE_STAGING_CONSOLE_APPLICATION_CREDENTIAL, "
    + "or explicitly set LIFESPACE_STAGING_CONSOLE_ROTATE_CREDENTIALS=1 with a secure credential sink for recovery/rotation.",
  );
}

async function ensureAudience() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/access-audiences`;
  const before = await request(identityBase, path, { bootstrap: true });
  if (before.response.status !== 200 || !Array.isArray(before.payload?.data)) {
    throw new Error(`Console Access audience listing failed: ${before.response.status} ${JSON.stringify(before.payload)}`);
  }
  const current = before.payload.data.find((entry) => entry?.audience === accessAudience && entry?.status === "active");
  if (current) return { created: false, audience: current };
  const created = await request(identityBase, path, { method: "POST", bootstrap: true, body: { audience: accessAudience } });
  if (![200, 201].includes(created.response.status) || created.payload?.data?.audience !== accessAudience) {
    throw new Error(`Console Access audience registration failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  return { created: created.response.status === 201, audience: created.payload.data };
}

async function ensurePlatformAdministrator() {
  const result = await request(identityBase, `/bootstrap/v1/platform-administrators/${encodeURIComponent(platformAdminUserId)}`, {
    method: "PUT",
    bootstrap: true,
  });
  if (result.response.status !== 200 || result.payload?.data?.userId !== platformAdminUserId) {
    throw new Error(`Platform administrator assignment failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload.data;
}

async function listServicePrincipals(applicationCredential) {
  const result = await request(identityBase, "/api/v1/service-principals", { bearer: applicationCredential });
  if (result.response.status !== 200 || !Array.isArray(result.payload?.data)) {
    throw new Error(`Console service-principal listing failed; verify supplied lsa_* belongs to ${applicationId}: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload.data;
}

async function ensureCoreExecutor(applicationCredential) {
  const principals = await listServicePrincipals(applicationCredential);
  const matches = principals.filter((entry) => entry?.displayName === CORE_EXECUTOR_NAME);
  if (matches.length > 1) throw new Error(`Multiple service principals use reserved Console executor name ${CORE_EXECUTOR_NAME}`);
  if (!matches.length) {
    const created = await request(identityBase, "/api/v1/service-principals", {
      method: "POST",
      bearer: applicationCredential,
      body: {
        displayName: CORE_EXECUTOR_NAME,
        description: CORE_EXECUTOR_DESCRIPTION,
        maxScopes: CORE_EXECUTOR_SCOPES,
        createdByUserId: platformAdminUserId,
      },
    });
    if (created.response.status !== 201 || !created.payload?.data?.id?.startsWith("svc_")) {
      throw new Error(`Console Core executor creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
    }
    return { created: true, principal: created.payload.data };
  }

  const current = matches[0];
  const patch = {};
  if (current.description !== CORE_EXECUTOR_DESCRIPTION) patch.description = CORE_EXECUTOR_DESCRIPTION;
  if (!sameStringSet(current.maxScopes, CORE_EXECUTOR_SCOPES)) patch.maxScopes = CORE_EXECUTOR_SCOPES;
  if (current.status !== "active") patch.status = "active";
  if (!Object.keys(patch).length) return { created: false, updated: false, principal: current };
  const updated = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(current.id)}`, {
    method: "PATCH",
    bearer: applicationCredential,
    body: patch,
  });
  if (updated.response.status !== 200) throw new Error(`Console Core executor reconciliation failed: ${updated.response.status} ${JSON.stringify(updated.payload)}`);
  return { created: false, updated: true, principal: updated.payload?.data };
}

async function ensureCoreExecutorToken(applicationCredential, principalId) {
  const list = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens`, { bearer: applicationCredential });
  if (list.response.status !== 200 || !Array.isArray(list.payload?.data)) {
    throw new Error(`Console Core executor token listing failed: ${list.response.status} ${JSON.stringify(list.payload)}`);
  }
  const active = list.payload.data.filter((entry) => entry?.revokedAt == null && (!entry?.expiresAt || Date.parse(entry.expiresAt) > Date.now()));

  if (suppliedCoreBearer && !rotateCredentials) {
    return { bearer: suppliedCoreBearer, created: false, source: "environment", activeTokenCount: active.length };
  }
  if (active.length && !rotateCredentials) {
    throw new Error(
      `Console Core executor already has ${active.length} active opaque token(s), but plaintext cannot be recovered. `
      + "Set LIFESPACE_STAGING_CONSOLE_CORE_BEARER to the installed token or explicitly set LIFESPACE_STAGING_CONSOLE_ROTATE_CREDENTIALS=1 with a secure sink.",
    );
  }
  if (!secureSinkAvailable()) throw new Error("Core executor token creation/rotation requires GITHUB_ENV or LIFESPACE_STAGING_CONSOLE_CREDENTIAL_OUTPUT");

  const created = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens`, {
    method: "POST",
    bearer: applicationCredential,
    body: {
      label: CORE_TOKEN_LABEL,
      scopes: CORE_EXECUTOR_SCOPES,
      expiresAt: null,
      createdByUserId: platformAdminUserId,
    },
  });
  if (created.response.status !== 201 || typeof created.payload?.data?.token !== "string" || !created.payload.data.token.startsWith("lsp_svc_")) {
    throw new Error(`Console Core executor token creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  persistSecret("LIFESPACE_STAGING_CONSOLE_CORE_BEARER", created.payload.data.token);
  return { bearer: created.payload.data.token, created: true, source: rotateCredentials ? "rotation" : "initial", activeTokenCount: active.length + 1 };
}

async function verifyCoreBearer(applicationCredential, coreBearer, principal, actorApplicationId) {
  if (!principal?.id?.startsWith("svc_")) {
    throw new Error("Console Core executor service principal is invalid");
  }
  if (principal.clientId !== actorApplicationId) {
    throw new Error(`Console Core executor application mismatch: expected ${actorApplicationId}, found ${String(principal.clientId)}`);
  }
  const principalScopes = principal.maxScopes ?? [];
  if (!sameStringSet(principalScopes, CORE_EXECUTOR_SCOPES)) {
    throw new Error(`Console Core executor principal must have exactly the least-privilege scope ceiling ${CORE_EXECUTOR_SCOPES.join(" ")}; found ${Array.isArray(principalScopes) ? principalScopes.join(" ") : String(principalScopes)}`);
  }

  let tokenScopes = CORE_EXECUTOR_SCOPES;
  if (coreBearer.startsWith("lsp_svc_") || coreBearer.startsWith("lsp_pat_")) {
    const tokens = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principal.id)}/tokens`, { bearer: applicationCredential });
    if (tokens.response.status !== 200 || !Array.isArray(tokens.payload?.data)) {
      throw new Error(`Console Core executor token metadata lookup failed: ${tokens.response.status} ${JSON.stringify(tokens.payload)}`);
    }
    const current = tokens.payload.data.filter((entry) =>
      entry?.principalId === principal.id
      && entry?.revokedAt == null
      && (!entry?.expiresAt || Date.parse(entry.expiresAt) > Date.now())
      && entry?.lastFour === coreBearer.slice(-4)
      && entry?.label === CORE_TOKEN_LABEL
    );
    if (current.length !== 1) {
      throw new Error("Console Core executor token metadata could not be uniquely verified");
    }
    tokenScopes = current[0].scopes ?? [];
    if (!sameStringSet(tokenScopes, CORE_EXECUTOR_SCOPES)) {
      throw new Error(`Console Core executor token must have exactly the least-privilege scope set ${CORE_EXECUTOR_SCOPES.join(" ")}; found ${Array.isArray(tokenScopes) ? tokenScopes.join(" ") : String(tokenScopes)}`);
    }
  } else if (coreBearer.split(".").length !== 3) {
    throw new Error("Console Core executor bearer must be an opaque service token or service JWT");
  }

  const result = await request(coreBase, "/api/v1/model-admin/models", { bearer: coreBearer });
  if (result.response.status !== 200 || !Array.isArray(result.payload?.data)) {
    throw new Error(`Console Core bearer does not authorize the service-only Model Admin read boundary: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return { id: principal.id, clientId: principal.clientId, scopes: tokenScopes };
}

const convergence = await requireStagingConvergence();
let applicationLookup = await loadApplication();
let applicationCreated = false;
let initialApplicationSecret = null;
if (applicationLookup.response.status === 404) {
  initialApplicationSecret = await createApplication();
  applicationCreated = true;
  applicationLookup = await loadApplication();
}
if (applicationLookup.response.status !== 200 || applicationLookup.payload?.data?.id !== applicationId) {
  throw new Error(`Console application lookup failed: ${applicationLookup.response.status} ${JSON.stringify(applicationLookup.payload)}`);
}

const applicationState = await reconcileApplication(applicationLookup.payload.data);
const audienceState = await ensureAudience();
// Assignment of a platform administrator is a first-seed/recovery operation,
 // not part of routine staging Console convergence. Missing existing
 // assignment is detected by the later authenticated Console verification.
const administratorState = applicationCreated || recoverPlatformAdmin
  ? await ensurePlatformAdministrator()
  : { status: "unchanged-unverified" };
const applicationCredentialState = await ensureApplicationCredential(applicationCreated, initialApplicationSecret);
const executorState = await ensureCoreExecutor(applicationCredentialState.credential);
const coreTokenState = await ensureCoreExecutorToken(applicationCredentialState.credential, executorState.principal.id);
const corePrincipal = await verifyCoreBearer(applicationCredentialState.credential, coreTokenState.bearer, executorState.principal, applicationId);

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  contracts: {
    identity: convergence.identity.contractVersion,
    coreKernel: convergence.core.contractVersion,
    identityPlatformAdmin: "0.6.0",
    corePlatformAdmin: "0.5.0",
  },
  schemas: {
    identity: convergence.identity.schemaVersion,
    core: convergence.core.schemaVersion,
  },
  application: {
    id: applicationId,
    name: applicationName,
    created: applicationCreated,
    updated: applicationState.updated,
    allowedScopes: APPLICATION_SCOPES,
  },
  accessAudience: {
    audience: accessAudience,
    issuer: audienceState.audience?.issuer ?? null,
    created: audienceState.created,
    status: audienceState.audience?.status ?? null,
  },
  platformAdministrator: {
    userId: platformAdminUserId,
    status: administratorState.status,
    assignmentRequested: applicationCreated || recoverPlatformAdmin,
  },
  identityExecutorCredential: {
    source: applicationCredentialState.source,
    created: applicationCredentialState.created,
    plaintextLogged: false,
  },
  coreExecutor: {
    principalId: executorState.principal.id,
    principalCreated: executorState.created,
    principalUpdated: executorState.updated ?? false,
    scopes: CORE_EXECUTOR_SCOPES,
    tokenSource: coreTokenState.source,
    tokenCreated: coreTokenState.created,
    activeTokenCount: coreTokenState.activeTokenCount,
    authenticatedPrincipalId: corePrincipal.id,
  },
  credentialOutput: credentialOutput || (githubEnv ? "GITHUB_ENV" : null),
  productionTouched: false,
}, null, 2));
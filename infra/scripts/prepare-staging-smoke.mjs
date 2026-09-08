import { appendFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const githubEnv = process.env.GITHUB_ENV ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const runAttempt = (process.env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^0-9A-Za-z_-]/gu, "_");
const smokeId = `${runId}_${runAttempt}`;
const applicationId = `app_staging_smoke_${smokeId}`;
const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  GITHUB_ENV: githubEnv,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");

const applicationScopes = [
  "profile:read",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "grants:manage",
  "resources:read",
  "resources:write",
  "creation-drafts:read",
  "creation-drafts:write",
  "models:manage",
];
const userScopes = [...applicationScopes];
const serviceScopes = ["models:manage", "resources:read", "resources:write"];
const modelKeys = ["task", "wish", "day_record", "event"];

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function exportEnv(name, value, { secret = false } = {}) {
  if (secret) mask(value);
  if (String(value).includes("\n") || String(value).includes("\r")) throw new Error(`${name} cannot contain newlines`);
  appendFileSync(githubEnv, `${name}=${value}\n`, "utf8");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function wranglerSecretBulk(cwd, secrets) {
  execFileSync("pnpm", ["exec", "wrangler", "secret", "bulk", "--env", "staging"], {
    cwd,
    env: process.env,
    input: JSON.stringify(secrets),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

async function runCoreSql(sql) {
  await executeStagingD1Sql({ cwd: CORE_DIR, sql });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

async function requestUntil(label, request, predicate, attempts = 12, delayMs = 2500) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      last = await request();
      if (predicate(last)) return last;
    } catch (error) {
      last = { error };
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const detail = last?.response ? `${last.response.status} ${JSON.stringify(last.payload)}` : String(last?.error ?? "no response");
  throw new Error(`${label} did not converge: ${detail}`);
}

async function jsonRequest(base, path, { method = "GET", bearer, bootstrap, body } = {}) {
  return fetchJson(`${base}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(bootstrap ? { "x-bootstrap-secret": bootstrap } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function issueUserToken(clientSecret, userId) {
  return jsonRequest(identityBase, "/internal/v1/tokens", {
    method: "POST",
    bearer: clientSecret,
    body: { subjectId: userId, scopes: userScopes },
  });
}

async function createSmokeUser(clientSecret, displayName) {
  const user = await jsonRequest(identityBase, "/internal/v1/users", {
    method: "POST", bearer: clientSecret, body: { displayName },
  });
  if (user.response.status !== 201 || !user.payload?.data?.id) {
    throw new Error(`Staging smoke user creation failed: ${user.response.status} ${JSON.stringify(user.payload)}`);
  }
  return user.payload.data.id;
}

async function issueAndProbeUser(clientSecret, userId, label) {
  const tokenResult = await issueUserToken(clientSecret, userId);
  const bearer = tokenResult.payload?.data?.accessToken ?? "";
  const probe = bearer ? await jsonRequest(coreBase, "/api/v1/me", { bearer }) : null;
  if (tokenResult.response.status !== 200 || !bearer || probe?.response.status !== 200) {
    throw new Error(`${label} token verification failed: identity=${tokenResult.response.status} core=${probe?.response.status ?? "not-called"}`);
  }
  mask(bearer);
  return bearer;
}

function repairSigningKeys() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  wranglerSecretBulk(IDENTITY_DIR, {
    BOOTSTRAP_SECRET: bootstrapSecret,
    TOKEN_PRIVATE_KEY: pair.privateKey,
    TOKEN_PUBLIC_KEY: pair.publicKey,
  });
  wranglerSecretBulk(CORE_DIR, { IDENTITY_PUBLIC_KEY: pair.publicKey });
  console.log("Repaired staging RS256 signing/verification key alignment");
}

function repairServiceIntrospectionSecret() {
  const shared = randomBytes(32).toString("base64url");
  wranglerSecretBulk(IDENTITY_DIR, { BOOTSTRAP_SECRET: bootstrapSecret, CORE_IDENTITY_SHARED_SECRET: shared });
  wranglerSecretBulk(CORE_DIR, { CORE_IDENTITY_SHARED_SECRET: shared });
  console.log("Repaired staging Core↔Identity opaque-token introspection secret alignment");
}

wranglerSecretBulk(IDENTITY_DIR, { BOOTSTRAP_SECRET: bootstrapSecret });
await requestUntil(
  "Identity health after bootstrap-secret synchronization",
  () => fetchJson(`${identityBase}/health`),
  ({ response }) => response.status === 200,
);

const app = await requestUntil(
  "staging smoke application bootstrap",
  () => jsonRequest(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: bootstrapSecret,
    body: {
      id: applicationId,
      name: `LifeSpace staging smoke ${smokeId}`,
      clientType: "service",
      allowedScopes: applicationScopes,
      trustedBackend: true,
      accessTokenTtlSeconds: 900,
    },
  }),
  ({ response }) => response.status === 201,
);
const clientSecret = app.payload?.data?.clientSecret;
if (!clientSecret) throw new Error("Staging smoke application did not return a client secret");
mask(clientSecret);

const userId = await createSmokeUser(clientSecret, `Staging Owner ${smokeId}`);
let userTokenResult = await issueUserToken(clientSecret, userId);
let userBearer = userTokenResult.payload?.data?.accessToken ?? "";
let coreUserProbe = userBearer ? await jsonRequest(coreBase, "/api/v1/me", { bearer: userBearer }) : null;
const needsSigningRepair =
  (userTokenResult.response.status === 500 && userTokenResult.payload?.error?.code === "IDENTITY_NOT_CONFIGURED")
  || (userBearer && coreUserProbe?.response.status === 401);

if (needsSigningRepair) {
  repairSigningKeys();
  const repaired = await requestUntil(
    "staging user JWT signing/verification alignment",
    async () => {
      const tokenResult = await issueUserToken(clientSecret, userId);
      const bearer = tokenResult.payload?.data?.accessToken ?? "";
      const probe = bearer ? await jsonRequest(coreBase, "/api/v1/me", { bearer }) : null;
      return { tokenResult, bearer, probe };
    },
    ({ tokenResult, bearer, probe }) => tokenResult.response.status === 200 && Boolean(bearer) && probe?.response.status === 200,
    12,
    5000,
  );
  userTokenResult = repaired.tokenResult;
  userBearer = repaired.bearer;
  coreUserProbe = repaired.probe;
}

if (userTokenResult.response.status !== 200 || !userBearer) {
  throw new Error(`Staging user token issuance failed: ${userTokenResult.response.status} ${JSON.stringify(userTokenResult.payload)}`);
}
if (coreUserProbe?.response.status !== 200) {
  throw new Error(`Core user-token verification failed: ${coreUserProbe?.response.status} ${JSON.stringify(coreUserProbe?.payload)}`);
}
mask(userBearer);

const claimantUserId = await createSmokeUser(clientSecret, `Staging Claimant ${smokeId}`);
const claimantBearer = await issueAndProbeUser(clientSecret, claimantUserId, "Staging claimant user");

const servicePrincipal = await jsonRequest(identityBase, "/api/v1/service-principals", {
  method: "POST",
  bearer: clientSecret,
  body: {
    displayName: `Staging Service ${smokeId}`,
    description: "Ephemeral staging-only model-admin and Runtime performance principal",
    maxScopes: serviceScopes,
    createdByUserId: userId,
  },
});
if (servicePrincipal.response.status !== 201 || !servicePrincipal.payload?.data?.id) {
  throw new Error(`Staging service principal creation failed: ${servicePrincipal.response.status} ${JSON.stringify(servicePrincipal.payload)}`);
}
const servicePrincipalId = servicePrincipal.payload.data.id;
const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
const serviceTokenResult = await jsonRequest(identityBase, `/api/v1/service-principals/${servicePrincipalId}/tokens`, {
  method: "POST",
  bearer: clientSecret,
  body: {
    label: `LifeSpace staging smoke ${smokeId}`,
    scopes: serviceScopes,
    expiresAt,
    createdByUserId: userId,
  },
});
const serviceBearer = serviceTokenResult.payload?.data?.token ?? "";
const serviceTokenId = serviceTokenResult.payload?.data?.id ?? "";
if (serviceTokenResult.response.status !== 201 || !serviceBearer || !serviceTokenId) {
  throw new Error(`Staging service token creation failed: ${serviceTokenResult.response.status} ${JSON.stringify(serviceTokenResult.payload)}`);
}
mask(serviceBearer);

let modelAdminProbe = await jsonRequest(coreBase, "/api/v1/model-admin/models", { bearer: serviceBearer });
if (modelAdminProbe.response.status !== 200) {
  repairServiceIntrospectionSecret();
  modelAdminProbe = await requestUntil(
    "staging opaque service-token introspection",
    () => jsonRequest(coreBase, "/api/v1/model-admin/models", { bearer: serviceBearer }),
    ({ response }) => response.status === 200,
    12,
    5000,
  );
}
if (modelAdminProbe.response.status !== 200) {
  throw new Error(`Core Model Admin service-token verification failed: ${modelAdminProbe.response.status} ${JSON.stringify(modelAdminProbe.payload)}`);
}

const now = new Date().toISOString();
const accessValues = modelKeys
  .map((key) => `(${sqlString(applicationId)},${sqlString(key)},'write','service',${sqlString(servicePrincipalId)},${sqlString(now)},${sqlString(now)})`)
  .join(",");
await runCoreSql(`INSERT INTO application_model_access(
  application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
) VALUES ${accessValues}
ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`);

const space = await jsonRequest(coreBase, "/api/v1/spaces", {
  method: "POST",
  bearer: userBearer,
  body: {
    kind: "personal",
    name: `LifeSpace staging smoke ${smokeId}`,
    ownerDisplayName: `Staging Owner ${smokeId}`,
    timezone: "UTC",
  },
});
if (space.response.status !== 201 || !space.payload?.data?.id || !space.payload?.data?.ownerPersonId) {
  throw new Error(`Staging smoke Space creation failed: ${space.response.status} ${JSON.stringify(space.payload)}`);
}
const spaceId = space.payload.data.id;
const personId = space.payload.data.ownerPersonId;

const serviceGrant = await jsonRequest(coreBase, `/api/v1/spaces/${spaceId}/grants`, {
  method: "POST",
  bearer: userBearer,
  body: {
    granteeType: "service",
    granteeId: servicePrincipalId,
    resourceType: "space",
    resourceId: null,
    permission: "write",
    expiresAt,
  },
});
if (serviceGrant.response.status !== 201 || !serviceGrant.payload?.data?.id) {
  throw new Error(`Staging Runtime service grant creation failed: ${serviceGrant.response.status} ${JSON.stringify(serviceGrant.payload)}`);
}
const serviceGrantId = serviceGrant.payload.data.id;

const serviceRuntimeProbe = await jsonRequest(coreBase, `/api/v1/spaces/${spaceId}/models/task/records?limit=1`, { bearer: serviceBearer });
if (serviceRuntimeProbe.response.status !== 200) {
  throw new Error(`Core Runtime service-token verification failed: ${serviceRuntimeProbe.response.status} ${JSON.stringify(serviceRuntimeProbe.payload)}`);
}

const claimantMembership = await jsonRequest(coreBase, `/api/v1/spaces/${spaceId}/members`, {
  method: "POST",
  bearer: userBearer,
  body: { userId: claimantUserId, role: "editor", displayName: `Staging Claimant ${smokeId}` },
});
if (claimantMembership.response.status !== 201 || !claimantMembership.payload?.data?.personId) {
  throw new Error(`Staging claimant membership creation failed: ${claimantMembership.response.status} ${JSON.stringify(claimantMembership.payload)}`);
}
const claimantPersonId = claimantMembership.payload.data.personId;

exportEnv("LIFESPACE_CORE_STAGING_URL", coreBase);
exportEnv("LIFESPACE_IDENTITY_STAGING_URL", identityBase);
exportEnv("LIFESPACE_STAGING_MODEL_ADMIN_BEARER", serviceBearer, { secret: true });
exportEnv("LIFESPACE_STAGING_SERVICE_BEARER", serviceBearer, { secret: true });
exportEnv("LIFESPACE_STAGING_USER_BEARER", userBearer, { secret: true });
exportEnv("LIFESPACE_STAGING_CLAIMANT_USER_BEARER", claimantBearer, { secret: true });
exportEnv("LIFESPACE_STAGING_SPACE_ID", spaceId);
exportEnv("LIFESPACE_STAGING_PERSON_ID", personId);
exportEnv("LIFESPACE_STAGING_CLAIMANT_PERSON_ID", claimantPersonId);
exportEnv("LIFESPACE_STAGING_SPACE_TIMEZONE", "UTC");
exportEnv("LIFESPACE_STAGING_VIEWING_TIMEZONE", "UTC");
exportEnv("LIFESPACE_STAGING_SMOKE_APPLICATION_ID", applicationId);
exportEnv("LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET", clientSecret, { secret: true });
exportEnv("LIFESPACE_STAGING_SMOKE_USER_ID", userId);
exportEnv("LIFESPACE_STAGING_SMOKE_CLAIMANT_USER_ID", claimantUserId);
exportEnv("LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID", servicePrincipalId);
exportEnv("LIFESPACE_STAGING_SMOKE_SERVICE_TOKEN_ID", serviceTokenId);
exportEnv("LIFESPACE_STAGING_SMOKE_SERVICE_GRANT_ID", serviceGrantId);
exportEnv("ALLOW_AI_UNCONFIGURED", "1");

console.log(JSON.stringify({
  ok: true,
  applicationId,
  userId,
  claimantUserId,
  servicePrincipalId,
  serviceTokenExpiresAt: expiresAt,
  serviceRuntimeGrantId: serviceGrantId,
  spaceId,
  personId,
  claimantPersonId,
  modelAccess: Object.fromEntries(modelKeys.map((key) => [key, "write"])),
  wishPolicyActorsPrepared: { owner: personId, claimant: claimantPersonId },
  serviceRuntimePerformanceReady: true,
  secretsMaskedAndExportedToCurrentJob: true,
}, null, 2));


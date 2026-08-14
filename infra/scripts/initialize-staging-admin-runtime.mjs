import { execFileSync } from "node:child_process";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const accessTeamDomain = (process.env.LIFESPACE_STAGING_ADMIN_ACCESS_TEAM_DOMAIN ?? "").replace(/\/+$/u, "");
const accessAudience = process.env.LIFESPACE_STAGING_ADMIN_ACCESS_AUD ?? "";
const ADMIN_DIR = new URL("../../apps/admin/", import.meta.url);
const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const APPLICATION_ID = "app_lifespace_admin_staging";
const APPLICATION_NAME = "LifeSpace Admin Staging Control Plane";
const PRINCIPAL_NAME = "LifeSpace Admin Staging Control Plane";
const TOKEN_LABEL = "LifeSpace Admin staging runtime";
const ADMIN_SCOPES = ["models:manage"];

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_ADMIN_ACCESS_TEAM_DOMAIN: accessTeamDomain,
  LIFESPACE_STAGING_ADMIN_ACCESS_AUD: accessAudience,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^https:\/\/[A-Za-z0-9.-]+\.cloudflareaccess\.com$/u.test(accessTeamDomain)) {
  throw new Error("LIFESPACE_STAGING_ADMIN_ACCESS_TEAM_DOMAIN must be an https://<team>.cloudflareaccess.com URL");
}
if (!/^[A-Za-z0-9_-]{8,256}$/u.test(accessAudience)) {
  throw new Error("LIFESPACE_STAGING_ADMIN_ACCESS_AUD is invalid");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
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

async function identityRequest(path, { method = "GET", bootstrap = false, bearer, body } = {}) {
  return fetchJson(`${identityBase}${path}`, {
    method,
    headers: {
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function coreRequest(path, bearer) {
  return fetchJson(`${coreBase}${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
}

function assertStatus(result, expected, label) {
  if (result.response.status !== expected) {
    throw new Error(`${label} failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

async function ensureApplication() {
  let existing = await identityRequest(`/bootstrap/v1/applications/${APPLICATION_ID}`, { bootstrap: true });
  let clientSecret = "";
  let credentialId = "";

  if (existing.response.status === 404) {
    const created = await identityRequest("/bootstrap/v1/applications", {
      method: "POST",
      bootstrap: true,
      body: {
        id: APPLICATION_ID,
        name: APPLICATION_NAME,
        clientType: "service",
        allowedScopes: ADMIN_SCOPES,
        trustedBackend: true,
        accessTokenTtlSeconds: 900,
      },
    });
    const data = assertStatus(created, 201, "Admin staging application creation");
    clientSecret = data?.clientSecret ?? "";
    if (!clientSecret) throw new Error("Admin staging application did not return its initial credential");
    mask(clientSecret);

    const credentials = await identityRequest(`/bootstrap/v1/applications/${APPLICATION_ID}/credentials`, { bootstrap: true });
    const rows = assertStatus(credentials, 200, "Admin staging application credential listing");
    const match = Array.isArray(rows) ? rows.find((row) => row?.status === "active" && row?.secretSuffix === clientSecret.slice(-8)) : null;
    credentialId = match?.id ?? "";
    if (!credentialId) throw new Error("Admin staging initial application credential metadata was not found");
    return { clientSecret, credentialId };
  }

  const application = assertStatus(existing, 200, "Admin staging application lookup");
  if (application?.clientType !== "service" || application?.trustedBackend !== true) {
    throw new Error("Existing Admin staging application has an incompatible clientType/trustedBackend boundary");
  }

  const desiredScopes = JSON.stringify(ADMIN_SCOPES);
  const currentScopes = JSON.stringify(Array.isArray(application.allowedScopes) ? application.allowedScopes : []);
  if (
    application.name !== APPLICATION_NAME
    || application.status !== "active"
    || application.accessTokenTtlSeconds !== 900
    || currentScopes !== desiredScopes
  ) {
    const updated = await identityRequest(`/bootstrap/v1/applications/${APPLICATION_ID}`, {
      method: "PATCH",
      bootstrap: true,
      body: {
        name: APPLICATION_NAME,
        allowedScopes: ADMIN_SCOPES,
        accessTokenTtlSeconds: 900,
        status: "active",
      },
    });
    assertStatus(updated, 200, "Admin staging application reconciliation");
  }

  const credential = await identityRequest(`/bootstrap/v1/applications/${APPLICATION_ID}/credentials`, {
    method: "POST",
    bootstrap: true,
  });
  const data = assertStatus(credential, 201, "Admin staging temporary application credential creation");
  clientSecret = data?.clientSecret ?? "";
  credentialId = data?.id ?? "";
  if (!clientSecret || !credentialId) throw new Error("Admin staging temporary application credential was incomplete");
  mask(clientSecret);
  return { clientSecret, credentialId };
}

async function ensurePrincipal(clientSecret) {
  const listed = await identityRequest("/api/v1/service-principals", { bearer: clientSecret });
  const rows = assertStatus(listed, 200, "Admin staging service-principal listing");
  const matches = Array.isArray(rows) ? rows.filter((row) => row?.displayName === PRINCIPAL_NAME) : [];
  if (matches.length > 1) throw new Error("Multiple Admin staging service principals exist; refusing ambiguous reconciliation");

  if (!matches.length) {
    const created = await identityRequest("/api/v1/service-principals", {
      method: "POST",
      bearer: clientSecret,
      body: {
        displayName: PRINCIPAL_NAME,
        description: "Dedicated LifeSpace Admin staging control-plane authority",
        maxScopes: ADMIN_SCOPES,
      },
    });
    const data = assertStatus(created, 201, "Admin staging service-principal creation");
    if (!data?.id) throw new Error("Admin staging service-principal id is missing");
    return data;
  }

  const principal = matches[0];
  if (
    principal.status !== "active"
    || JSON.stringify(principal.maxScopes ?? []) !== JSON.stringify(ADMIN_SCOPES)
    || principal.description !== "Dedicated LifeSpace Admin staging control-plane authority"
  ) {
    const updated = await identityRequest(`/api/v1/service-principals/${principal.id}`, {
      method: "PATCH",
      bearer: clientSecret,
      body: {
        displayName: PRINCIPAL_NAME,
        description: "Dedicated LifeSpace Admin staging control-plane authority",
        maxScopes: ADMIN_SCOPES,
        status: "active",
      },
    });
    return assertStatus(updated, 200, "Admin staging service-principal reconciliation");
  }
  return principal;
}

function adminSecretBulk(secrets) {
  execFileSync(
    "pnpm",
    ["exec", "wrangler", "secret", "bulk", "--env", "staging", "--config", "../admin/wrangler.jsonc"],
    {
      cwd: CORE_DIR,
      env: process.env,
      input: JSON.stringify(secrets),
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
}

async function revokeToken(clientSecret, principalId, tokenId) {
  const result = await identityRequest(`/api/v1/service-principals/${principalId}/tokens/${tokenId}`, {
    method: "DELETE",
    bearer: clientSecret,
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Admin staging old token revocation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

async function revokeApplicationCredential(credentialId) {
  if (!credentialId) return;
  const result = await identityRequest(`/bootstrap/v1/applications/${APPLICATION_ID}/credentials/${credentialId}`, {
    method: "DELETE",
    bootstrap: true,
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Admin staging temporary application credential revocation failed: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

const { clientSecret, credentialId } = await ensureApplication();
let newTokenId = "";
let principalId = "";
let installed = false;

try {
  const principal = await ensurePrincipal(clientSecret);
  principalId = principal.id;

  const tokensResult = await identityRequest(`/api/v1/service-principals/${principalId}/tokens`, { bearer: clientSecret });
  const tokens = assertStatus(tokensResult, 200, "Admin staging service-token listing");
  const previousActiveTokenIds = Array.isArray(tokens)
    ? tokens.filter((token) => token?.revokedAt === null).map((token) => token.id).filter(Boolean)
    : [];

  const createdToken = await identityRequest(`/api/v1/service-principals/${principalId}/tokens`, {
    method: "POST",
    bearer: clientSecret,
    body: {
      label: TOKEN_LABEL,
      scopes: ADMIN_SCOPES,
      expiresAt: null,
    },
  });
  const tokenData = assertStatus(createdToken, 201, "Admin staging service-token creation");
  const coreAdminToken = tokenData?.token ?? "";
  newTokenId = tokenData?.id ?? "";
  if (!coreAdminToken || !newTokenId) throw new Error("Admin staging service token response was incomplete");
  mask(coreAdminToken);

  const coreProbe = await coreRequest(`/internal/v1/application-model-access/${APPLICATION_ID}`, coreAdminToken);
  assertStatus(coreProbe, 200, "Admin staging Core control-plane token probe");

  adminSecretBulk({
    CF_ACCESS_TEAM_DOMAIN: accessTeamDomain,
    CF_ACCESS_AUD: accessAudience,
    IDENTITY_BOOTSTRAP_SECRET: bootstrapSecret,
    CORE_ADMIN_TOKEN: coreAdminToken,
  });
  installed = true;

  for (const tokenId of previousActiveTokenIds) {
    if (tokenId !== newTokenId) await revokeToken(clientSecret, principalId, tokenId);
  }

  console.log(JSON.stringify({
    ok: true,
    environment: "staging",
    applicationId: APPLICATION_ID,
    servicePrincipalId: principalId,
    serviceTokenId: newTokenId,
    serviceTokenScopes: ADMIN_SCOPES,
    serviceTokenExpiresAt: null,
    workerSecretsInstalled: ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "IDENTITY_BOOTSTRAP_SECRET", "CORE_ADMIN_TOKEN"],
    oldRuntimeTokensRevoked: previousActiveTokenIds.filter((tokenId) => tokenId !== newTokenId).length,
    plaintextSecretsLogged: false,
  }, null, 2));
} catch (error) {
  if (!installed && principalId && newTokenId) {
    await revokeToken(clientSecret, principalId, newTokenId).catch(() => undefined);
  }
  throw error;
} finally {
  await revokeApplicationCredential(credentialId);
}

void ADMIN_DIR;

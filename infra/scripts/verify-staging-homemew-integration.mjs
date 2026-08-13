import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

const application = profile.application;
const applicationId = application.stagingId;
const allowedScopes = application.allowedUserScopes;
const forbiddenScopes = application.forbiddenUserScopes;
const modelAccess = profile.modelAccess;
const modelRoutes = {
  task: "tasks",
  wish: "wishes",
  day_record: "day-records",
  event: "events",
};

if (!applicationId || application.clientType !== "mini_program" || application.trustedBackend !== true) {
  throw new Error("HomeMew integration profile contains an invalid staging application definition");
}
if (!Array.isArray(allowedScopes) || !allowedScopes.length || allowedScopes.includes("models:manage")) {
  throw new Error("HomeMew integration profile must define product scopes without models:manage");
}
if (!Array.isArray(forbiddenScopes) || !forbiddenScopes.includes("models:manage")) {
  throw new Error("HomeMew integration profile must explicitly forbid models:manage");
}
if (Object.keys(modelAccess).some((key) => !(key in modelRoutes))) {
  throw new Error("HomeMew integration profile contains an unknown proving model key");
}
if (Object.values(modelAccess).some((access) => access !== "write")) {
  throw new Error("HomeMew proving models must currently be configured with write access");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runCoreSql(sql) {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--json", `--command=${sql}`],
    { cwd: CORE_DIR, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some((entry) => entry?.success === false)) throw new Error(`Core staging D1 mutation failed: ${output}`);
  return entries;
}

async function jsonRequest(base, path, { method = "GET", bootstrap, bearer, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bootstrap ? { "x-bootstrap-secret": bootstrap } : {}),
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

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Identity returned a malformed JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

const applicationPath = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
let metadata = await jsonRequest(identityBase, applicationPath, { bootstrap: bootstrapSecret });
let credentialId = "";
let applicationSecret = "";

if (metadata.response.status === 404) {
  const created = await jsonRequest(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: bootstrapSecret,
    body: {
      id: applicationId,
      name: "HomeMew staging",
      clientType: application.clientType,
      allowedScopes,
      trustedBackend: true,
      accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    },
  });
  applicationSecret = created.payload?.data?.clientSecret ?? "";
  if (created.response.status !== 201 || !applicationSecret.startsWith("lsa_")) {
    throw new Error(`HomeMew staging application creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  mask(applicationSecret);
  const credentials = await jsonRequest(identityBase, `${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
  const active = credentials.payload?.data?.filter((item) => item.status === "active" && item.revokedAt === null) ?? [];
  if (credentials.response.status !== 200 || active.length !== 1) {
    throw new Error(`Could not identify initial HomeMew staging credential: ${credentials.response.status} ${JSON.stringify(credentials.payload)}`);
  }
  credentialId = active[0].id;
} else if (metadata.response.status === 200) {
  const updated = await jsonRequest(identityBase, applicationPath, {
    method: "PATCH",
    bootstrap: bootstrapSecret,
    body: {
      name: "HomeMew staging",
      allowedScopes,
      accessTokenTtlSeconds: application.accessTokenTtlSeconds,
      status: "active",
    },
  });
  if (updated.response.status !== 200) {
    throw new Error(`HomeMew staging application policy update failed: ${updated.response.status} ${JSON.stringify(updated.payload)}`);
  }
  const replacement = await jsonRequest(identityBase, `${applicationPath}/credentials`, {
    method: "POST",
    bootstrap: bootstrapSecret,
  });
  credentialId = replacement.payload?.data?.id ?? "";
  applicationSecret = replacement.payload?.data?.clientSecret ?? "";
  if (replacement.response.status !== 201 || !credentialId.startsWith("apc_") || !applicationSecret.startsWith("lsa_")) {
    throw new Error(`HomeMew staging verifier credential creation failed: ${replacement.response.status} ${JSON.stringify(replacement.payload)}`);
  }
  mask(applicationSecret);
} else {
  throw new Error(`HomeMew staging application lookup failed: ${metadata.response.status} ${JSON.stringify(metadata.payload)}`);
}

try {
  metadata = await jsonRequest(identityBase, applicationPath, { bootstrap: bootstrapSecret });
  const current = metadata.payload?.data;
  if (
    metadata.response.status !== 200
    || current?.id !== applicationId
    || current?.clientType !== application.clientType
    || current?.trustedBackend !== true
    || current?.accessTokenTtlSeconds !== application.accessTokenTtlSeconds
    || !Array.isArray(current?.allowedScopes)
    || !sameSet(current.allowedScopes, allowedScopes)
    || current.allowedScopes.includes("models:manage")
  ) {
    throw new Error(`HomeMew staging application metadata does not match the profile: ${metadata.response.status} ${JSON.stringify(metadata.payload)}`);
  }

  const credentials = await jsonRequest(identityBase, `${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
  if (credentials.response.status !== 200 || !Array.isArray(credentials.payload?.data)) {
    throw new Error(`HomeMew application credential metadata lookup failed: ${credentials.response.status} ${JSON.stringify(credentials.payload)}`);
  }
  if (credentials.payload.data.some((item) => "clientSecret" in item || "secretHash" in item)) {
    throw new Error("HomeMew application credential metadata leaked plaintext or hash fields");
  }

  const tokenResult = await jsonRequest(identityBase, profile.trustedBackend.identityExchangePath, {
    method: "POST",
    bearer: applicationSecret,
    body: { subjectId: userId, scopes: allowedScopes },
  });
  const userBearer = tokenResult.payload?.data?.accessToken ?? "";
  if (tokenResult.response.status !== 200 || !userBearer) {
    throw new Error(`HomeMew user-token exchange failed: ${tokenResult.response.status} ${JSON.stringify(tokenResult.payload)}`);
  }
  mask(userBearer);

  const claims = decodeJwtPayload(userBearer);
  const tokenScopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/u).filter(Boolean) : [];
  if (
    claims.azp !== applicationId
    || claims.sub !== userId
    || claims.principal_type !== "user"
    || !sameSet(tokenScopes, allowedScopes)
    || tokenScopes.includes("models:manage")
    || claims.exp - claims.iat !== application.accessTokenTtlSeconds
    || tokenResult.payload?.data?.expiresIn !== application.accessTokenTtlSeconds
  ) {
    throw new Error(`HomeMew user token does not match the integration profile: ${JSON.stringify({ claims, response: tokenResult.payload?.data })}`);
  }

  for (const forbiddenScope of forbiddenScopes) {
    const denied = await jsonRequest(identityBase, profile.trustedBackend.identityExchangePath, {
      method: "POST",
      bearer: applicationSecret,
      body: { subjectId: userId, scopes: [...allowedScopes, forbiddenScope] },
    });
    if (denied.response.status !== 403) {
      throw new Error(`HomeMew scope ceiling did not reject ${forbiddenScope}: ${denied.response.status} ${JSON.stringify(denied.payload)}`);
    }
  }

  const profileRead = await jsonRequest(identityBase, "/api/v1/me", { bearer: userBearer });
  if (profileRead.response.status !== 200 || profileRead.payload?.data?.id !== userId) {
    throw new Error(`HomeMew-scoped token could not read Identity profile: ${profileRead.response.status} ${JSON.stringify(profileRead.payload)}`);
  }

  const now = new Date().toISOString();
  runCoreSql(`DELETE FROM application_model_access WHERE application_id=${sqlString(applicationId)}`);
  const accessValues = Object.entries(modelAccess)
    .map(([modelKey, maxAccess]) => `(${sqlString(applicationId)},${sqlString(modelKey)},${sqlString(maxAccess)},'user',${sqlString(userId)},${sqlString(now)},${sqlString(now)})`)
    .join(",");
  runCoreSql(`INSERT INTO application_model_access(
    application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
  ) VALUES ${accessValues}`);

  const coreMe = await jsonRequest(coreBase, "/api/v1/me", { bearer: userBearer });
  if (coreMe.response.status !== 200) {
    throw new Error(`HomeMew-scoped token could not reach Core /me: ${coreMe.response.status} ${JSON.stringify(coreMe.payload)}`);
  }

  const modelResults = {};
  for (const [modelKey, maxAccess] of Object.entries(modelAccess)) {
    const route = modelRoutes[modelKey];
    const result = await jsonRequest(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${route}?limit=1`, { bearer: userBearer });
    if (result.response.status !== 200 || !Array.isArray(result.payload?.data?.items)) {
      throw new Error(`HomeMew model access failed for ${modelKey}: ${result.response.status} ${JSON.stringify(result.payload)}`);
    }
    modelResults[modelKey] = maxAccess;
  }

  console.log(JSON.stringify({
    ok: true,
    applicationId,
    clientType: application.clientType,
    accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    allowedUserScopes: allowedScopes,
    forbiddenScopeRejection: forbiddenScopes,
    tokenApplicationBinding: claims.azp,
    modelAccess: modelResults,
    identityProfileRead: true,
    coreMembershipContextRead: true,
    credentialMetadataRedacted: true,
    productionUntouched: true,
  }, null, 2));
} finally {
  if (credentialId) {
    const revoke = await jsonRequest(identityBase, `${applicationPath}/credentials/${encodeURIComponent(credentialId)}`, {
      method: "DELETE",
      bootstrap: bootstrapSecret,
    });
    if (revoke.response.status !== 204 && revoke.response.status !== 404) {
      throw new Error(`HomeMew staging verifier credential cleanup failed: ${revoke.response.status} ${JSON.stringify(revoke.payload)}`);
    }
  }
}

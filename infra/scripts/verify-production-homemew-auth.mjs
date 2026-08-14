import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { assertProductionServiceUrl } from "./production-expectations.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_PRODUCTION_URL ?? "https://core.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));
const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);

assertProductionServiceUrl(identityBase, "identity");
assertProductionServiceUrl(coreBase, "core");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");

const application = profile.application;
const applicationId = application.productionId;
const allowedScopes = application.allowedUserScopes;
const forbiddenScopes = application.forbiddenUserScopes;
if (!applicationId || applicationId !== "homemew-miniprogram") throw new Error("HomeMew production application ID is not frozen correctly");
if (application.clientType !== "mini_program" || application.trustedBackend !== true) throw new Error("HomeMew production application definition is invalid");
if (!Array.isArray(allowedScopes) || !allowedScopes.length || allowedScopes.includes("models:manage")) {
  throw new Error("HomeMew production scopes are invalid");
}
if (!Array.isArray(forbiddenScopes) || !forbiddenScopes.includes("models:manage")) {
  throw new Error("HomeMew production profile must explicitly forbid models:manage");
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runIdentitySql(sql) {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "production", "--json", `--command=${sql}`],
    { cwd: IDENTITY_DIR, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some((entry) => entry?.success === false)) throw new Error(`Identity production D1 mutation failed: ${output}`);
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

function sameSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value) => right.includes(value));
}

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Identity returned a malformed JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

const applicationPath = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
let metadata = await jsonRequest(identityBase, applicationPath, { bootstrap: bootstrapSecret });
let initialCredentialId = "";

if (metadata.response.status === 404) {
  const created = await jsonRequest(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: bootstrapSecret,
    body: {
      id: applicationId,
      name: "HomeMew production",
      clientType: application.clientType,
      allowedScopes,
      trustedBackend: true,
      accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    },
  });
  const initialSecret = created.payload?.data?.clientSecret ?? "";
  if (created.response.status !== 201 || !initialSecret.startsWith("lsa_")) {
    throw new Error(`HomeMew production application creation failed: ${created.response.status} ${JSON.stringify(created.payload)}`);
  }
  mask(initialSecret);
  const credentials = await jsonRequest(identityBase, `${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
  const matching = credentials.payload?.data?.filter(
    (item) => item.status === "active" && item.revokedAt === null && item.secretSuffix === initialSecret.slice(-8),
  ) ?? [];
  if (credentials.response.status !== 200 || matching.length !== 1) {
    throw new Error(`Could not identify bootstrap-generated HomeMew production credential: ${credentials.response.status} ${JSON.stringify(credentials.payload)}`);
  }
  initialCredentialId = matching[0].id;
  const revoked = await jsonRequest(identityBase, `${applicationPath}/credentials/${encodeURIComponent(initialCredentialId)}`, {
    method: "DELETE",
    bootstrap: bootstrapSecret,
  });
  if (revoked.response.status !== 204) throw new Error(`Initial HomeMew production credential revocation failed: HTTP ${revoked.response.status}`);
} else if (metadata.response.status === 200) {
  const current = metadata.payload?.data;
  if (current?.clientType !== application.clientType || current?.trustedBackend !== true) {
    throw new Error(`Existing HomeMew production application has incompatible immutable metadata: ${JSON.stringify(current)}`);
  }
  const credentials = await jsonRequest(identityBase, `${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
  const active = credentials.payload?.data?.filter((item) => item.status === "active" && item.revokedAt === null) ?? [];
  if (credentials.response.status !== 200) throw new Error(`HomeMew production credential lookup failed: HTTP ${credentials.response.status}`);
  if (active.length) {
    throw new Error("HomeMew production already has an active application credential; refusing Phase 6 probe because this may indicate Phase 7/cutover activity");
  }
} else {
  throw new Error(`HomeMew production application lookup failed: ${metadata.response.status} ${JSON.stringify(metadata.payload)}`);
}

const updated = await jsonRequest(identityBase, applicationPath, {
  method: "PATCH",
  bootstrap: bootstrapSecret,
  body: {
    name: "HomeMew production",
    allowedScopes,
    accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    status: "active",
  },
});
if (updated.response.status !== 200) throw new Error(`HomeMew production application policy convergence failed: HTTP ${updated.response.status}`);
metadata = await jsonRequest(identityBase, applicationPath, { bootstrap: bootstrapSecret });
const current = metadata.payload?.data;
if (
  metadata.response.status !== 200
  || current?.id !== applicationId
  || current?.clientType !== application.clientType
  || current?.trustedBackend !== true
  || current?.accessTokenTtlSeconds !== application.accessTokenTtlSeconds
  || !sameSet(current?.allowedScopes, allowedScopes)
  || current.allowedScopes.includes("models:manage")
) {
  throw new Error(`HomeMew production application does not match the accepted profile: ${JSON.stringify(current)}`);
}

let probeCredentialId = "";
let probeUserId = "";
try {
  const credential = await jsonRequest(identityBase, `${applicationPath}/credentials`, {
    method: "POST",
    bootstrap: bootstrapSecret,
  });
  probeCredentialId = credential.payload?.data?.id ?? "";
  const applicationSecret = credential.payload?.data?.clientSecret ?? "";
  if (credential.response.status !== 201 || !probeCredentialId.startsWith("apc_") || !applicationSecret.startsWith("lsa_")) {
    throw new Error(`Production auth probe credential creation failed: ${credential.response.status} ${JSON.stringify(credential.payload)}`);
  }
  mask(applicationSecret);

  const user = await jsonRequest(identityBase, "/internal/v1/users", {
    method: "POST",
    bearer: applicationSecret,
    body: { displayName: `LifeSpace production auth probe ${process.env.GITHUB_RUN_ID ?? Date.now()}` },
  });
  probeUserId = user.payload?.data?.id ?? "";
  if (user.response.status !== 201 || !probeUserId.startsWith("usr_")) {
    throw new Error(`Production auth probe user creation failed: ${user.response.status} ${JSON.stringify(user.payload)}`);
  }

  const tokenResult = await jsonRequest(identityBase, profile.trustedBackend.identityExchangePath, {
    method: "POST",
    bearer: applicationSecret,
    body: { subjectId: probeUserId, scopes: allowedScopes },
  });
  const userBearer = tokenResult.payload?.data?.accessToken ?? "";
  if (tokenResult.response.status !== 200 || !userBearer) {
    throw new Error(`Production HomeMew user-token exchange failed: ${tokenResult.response.status} ${JSON.stringify(tokenResult.payload)}`);
  }
  mask(userBearer);
  const claims = decodeJwtPayload(userBearer);
  const tokenScopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/u).filter(Boolean) : [];
  if (
    claims.azp !== applicationId
    || claims.sub !== probeUserId
    || claims.principal_type !== "user"
    || !sameSet(tokenScopes, allowedScopes)
    || claims.exp - claims.iat !== application.accessTokenTtlSeconds
  ) {
    throw new Error(`Production HomeMew JWT claims do not match the accepted profile: ${JSON.stringify(claims)}`);
  }

  for (const forbiddenScope of forbiddenScopes) {
    const denied = await jsonRequest(identityBase, profile.trustedBackend.identityExchangePath, {
      method: "POST",
      bearer: applicationSecret,
      body: { subjectId: probeUserId, scopes: [...allowedScopes, forbiddenScope] },
    });
    if (denied.response.status !== 403) throw new Error(`Production scope ceiling did not reject ${forbiddenScope}: HTTP ${denied.response.status}`);
  }

  const identityMe = await jsonRequest(identityBase, "/api/v1/me", { bearer: userBearer });
  if (identityMe.response.status !== 200 || identityMe.payload?.data?.id !== probeUserId) {
    throw new Error(`Production Identity JWT verification failed: ${identityMe.response.status} ${JSON.stringify(identityMe.payload)}`);
  }
  const coreMe = await jsonRequest(coreBase, "/api/v1/me", { bearer: userBearer });
  if (coreMe.response.status !== 200) {
    throw new Error(`Production Core JWT verification failed: ${coreMe.response.status} ${JSON.stringify(coreMe.payload)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    applicationId,
    trustedBackend: true,
    accessTokenTtlSeconds: application.accessTokenTtlSeconds,
    allowedScopes,
    forbiddenScopeRejection: forbiddenScopes,
    identityJwtVerification: true,
    coreJwtVerification: true,
    finalCutoverCredentialIssued: false,
  }, null, 2));
} finally {
  if (probeCredentialId) {
    const revoked = await jsonRequest(identityBase, `${applicationPath}/credentials/${encodeURIComponent(probeCredentialId)}`, {
      method: "DELETE",
      bootstrap: bootstrapSecret,
    });
    if (revoked.response.status !== 204 && revoked.response.status !== 404) {
      throw new Error(`Production auth probe credential cleanup failed: HTTP ${revoked.response.status}`);
    }
  }
  if (probeUserId) {
    if (!/^usr_[a-f0-9]{32}$/u.test(probeUserId)) throw new Error(`Refusing to clean unexpected production probe user ID: ${probeUserId}`);
    runIdentitySql(`DELETE FROM users WHERE id=${sqlString(probeUserId)}`);
    const remaining = runIdentitySql(`SELECT COUNT(*) count FROM users WHERE id=${sqlString(probeUserId)}`);
    const rows = remaining.flatMap((entry) => entry?.results ?? entry?.result?.results ?? []);
    if (Number(rows[0]?.count ?? 1) !== 0) throw new Error(`Production auth probe user cleanup did not converge for ${probeUserId}`);
  }
}

import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const applicationId = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID ?? "";
const originalSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";

for (const [name, value] of Object.entries({
  LIFESPACE_IDENTITY_STAGING_URL: identityBase,
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_SMOKE_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: originalSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

async function jsonRequest(path, { method = "GET", bootstrap, bearer, body } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
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

const applicationPath = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
const metadata = await jsonRequest(applicationPath, { bootstrap: bootstrapSecret });
if (metadata.response.status !== 200 || metadata.payload?.data?.id !== applicationId) {
  throw new Error(`Application metadata verification failed: ${metadata.response.status} ${JSON.stringify(metadata.payload)}`);
}
const allowedScopes = metadata.payload.data.allowedScopes;
if (!Array.isArray(allowedScopes) || !allowedScopes.includes("resources:read")) {
  throw new Error(`Smoke application metadata is missing resources:read: ${JSON.stringify(metadata.payload)}`);
}

const beforeList = await jsonRequest(`${applicationPath}/credentials`, { bootstrap: bootstrapSecret });
if (beforeList.response.status !== 200 || !Array.isArray(beforeList.payload?.data)) {
  throw new Error(`Application credential list failed: ${beforeList.response.status} ${JSON.stringify(beforeList.payload)}`);
}
if (beforeList.payload.data.some((item) => "clientSecret" in item || "secretHash" in item)) {
  throw new Error("Application credential metadata leaked plaintext or hash fields");
}

const replacement = await jsonRequest(`${applicationPath}/credentials`, { method: "POST", bootstrap: bootstrapSecret });
const replacementId = replacement.payload?.data?.id ?? "";
const replacementSecret = replacement.payload?.data?.clientSecret ?? "";
if (replacement.response.status !== 201 || !String(replacementId).startsWith("apc_") || !String(replacementSecret).startsWith("lsa_")) {
  throw new Error(`Application credential replacement failed: ${replacement.response.status} ${JSON.stringify(replacement.payload)}`);
}
console.log(`::add-mask::${replacementSecret}`);
if (replacement.payload.data.secretHash !== undefined) throw new Error("Application credential create response leaked a hash");

const issueBody = { subjectId: userId, scopes: ["resources:read"] };
const replacementIssue = await jsonRequest("/internal/v1/tokens", {
  method: "POST",
  bearer: replacementSecret,
  body: issueBody,
});
if (replacementIssue.response.status !== 200 || !replacementIssue.payload?.data?.accessToken) {
  throw new Error(`Replacement application credential could not exchange a user token: ${replacementIssue.response.status} ${JSON.stringify(replacementIssue.payload)}`);
}

const revoke = await jsonRequest(`${applicationPath}/credentials/${encodeURIComponent(replacementId)}`, {
  method: "DELETE",
  bootstrap: bootstrapSecret,
});
if (revoke.response.status !== 204) {
  throw new Error(`Replacement application credential revoke failed: ${revoke.response.status} ${JSON.stringify(revoke.payload)}`);
}

const replacementAfterRevoke = await jsonRequest("/internal/v1/tokens", {
  method: "POST",
  bearer: replacementSecret,
  body: issueBody,
});
if (replacementAfterRevoke.response.status !== 401) {
  throw new Error(`Revoked replacement credential remained usable: ${replacementAfterRevoke.response.status}`);
}

const originalAfterReplacementRevoke = await jsonRequest("/internal/v1/tokens", {
  method: "POST",
  bearer: originalSecret,
  body: issueBody,
});
if (originalAfterReplacementRevoke.response.status !== 200 || !originalAfterReplacementRevoke.payload?.data?.accessToken) {
  throw new Error(`Original application credential was affected by replacement revoke: ${originalAfterReplacementRevoke.response.status} ${JSON.stringify(originalAfterReplacementRevoke.payload)}`);
}

console.log(JSON.stringify({
  ok: true,
  applicationId,
  allowedScopes,
  initialCredentialCount: beforeList.payload.data.length,
  replacementRevokedImmediately: true,
  originalCredentialRemainedActive: true,
  plaintextAndHashesAbsentFromList: true,
}, null, 2));

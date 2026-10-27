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
// Verify the smoke application's own live scope ceiling without Bootstrap
// authority; credential lifecycle mutation below remains a separate legacy path.
const metadata = await jsonRequest("/internal/v1/applications/self", { bearer: originalSecret });
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

// Register the newly issued id *before* every subsequent assertion. A failed
// token exchange must not leave a live staging application credential behind.
let replacementId = "";
let replacementSecret = "";
let replacementRevoked = false;
let primaryError = null;
let cleanupError = null;

try {
  const replacement = await jsonRequest(`${applicationPath}/credentials`, { method: "POST", bootstrap: bootstrapSecret });
  replacementId = replacement.payload?.data?.id ?? "";
  replacementSecret = replacement.payload?.data?.clientSecret ?? "";
  // Mask as soon as possible, including when the response is malformed.
  // Never stringify a secret-bearing POST response into an Actions error.
  if (typeof replacementSecret === "string" && replacementSecret) console.log(`::add-mask::${replacementSecret}`);
  if (replacement.response.status !== 201 || !String(replacementId).startsWith("apc_") || !String(replacementSecret).startsWith("lsa_")) {
    throw new Error(`Application credential replacement returned an invalid response: HTTP ${replacement.response.status}`);
  }
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
  replacementRevoked = true;

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
} catch (error) {
  primaryError = error;
} finally {
  // A failed verification or revoked-credential check still attempts cleanup.
  // When creation never returned an ID, safe targeted cleanup is impossible;
  // never guess a different credential to revoke.
  if (replacementId && !replacementRevoked) {
    try {
      const cleanup = await jsonRequest(`${applicationPath}/credentials/${encodeURIComponent(replacementId)}`, {
        method: "DELETE",
        bootstrap: bootstrapSecret,
      });
      if (cleanup.response.status !== 204 && cleanup.response.status !== 404) {
        throw new Error(`Temporary replacement cleanup failed: HTTP ${cleanup.response.status}`);
      }
      replacementRevoked = true;
    } catch (error) {
      cleanupError = error;
    }
  }
}

if (primaryError || cleanupError) {
  if (primaryError && cleanupError) {
    throw new Error(`${primaryError instanceof Error ? primaryError.message : String(primaryError)}; cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
  }
  throw primaryError ?? cleanupError;
}

console.log(JSON.stringify({
  ok: true,
  applicationId,
  allowedScopes,
  initialCredentialCount: beforeList.payload.data.length,
  replacementRevokedImmediately: replacementRevoked,
  originalCredentialRemainedActive: true,
  plaintextAndHashesAbsentFromList: true,
}, null, 2));

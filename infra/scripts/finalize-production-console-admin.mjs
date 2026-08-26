import process from "node:process";
import { assertProductionServiceUrl } from "./production-expectations.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
const applicationId = (process.env.LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_ID ?? "app_lifespace_console").trim();
const applicationCredential = (process.env.LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_CREDENTIAL ?? "").trim();
const currentCredentialId = (process.env.LIFESPACE_PRODUCTION_CONSOLE_CURRENT_CREDENTIAL_ID ?? "").trim();
const oldCredentialIds = (process.env.LIFESPACE_PRODUCTION_CONSOLE_OLD_CREDENTIAL_IDS ?? "none").split(",").filter((value) => value && value !== "none");
const principalId = (process.env.LIFESPACE_PRODUCTION_CONSOLE_CORE_PRINCIPAL_ID ?? "").trim();
const currentTokenId = (process.env.LIFESPACE_PRODUCTION_CONSOLE_CURRENT_CORE_TOKEN_ID ?? "").trim();
const oldTokenIds = (process.env.LIFESPACE_PRODUCTION_CONSOLE_OLD_CORE_TOKEN_IDS ?? "none").split(",").filter((value) => value && value !== "none");

assertProductionServiceUrl(identityBase, "identity");
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!applicationCredential.startsWith("lsa_")) throw new Error("LIFESPACE_PRODUCTION_CONSOLE_APPLICATION_CREDENTIAL is invalid");
if (!/^app_[0-9A-Za-z_-]+$/u.test(applicationId)) throw new Error("Production Console application id is invalid");
if (!currentCredentialId || !principalId.startsWith("svc_") || !currentTokenId.startsWith("sat_")) throw new Error("Current production Console credential metadata is incomplete");

function mask(value) {
  if (value) console.log(`::add-mask::${value}`);
}
mask(bootstrapSecret);
mask(applicationCredential);

async function request(path, { method = "GET", bootstrap = false, bearer = "" } = {}) {
  const response = await fetch(`${identityBase}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

for (const credentialId of oldCredentialIds) {
  const result = await request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
    bootstrap: true,
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Could not revoke superseded production Console application credential ${credentialId}: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

for (const tokenId of oldTokenIds) {
  const result = await request(`/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
    bearer: applicationCredential,
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Could not revoke superseded production Console Core token ${tokenId}: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

const credentials = await request(`/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, { bootstrap: true });
if (credentials.response.status !== 200 || !Array.isArray(credentials.payload?.data)) throw new Error("Could not verify production Console application credential metadata after cleanup");
const currentCredential = credentials.payload.data.find((entry) => entry?.id === currentCredentialId && entry?.status === "active" && entry?.revokedAt == null);
if (!currentCredential) throw new Error("Current production Console application credential is not active after cleanup");
const unexpectedOldCredential = credentials.payload.data.find((entry) => oldCredentialIds.includes(entry?.id) && entry?.status === "active" && entry?.revokedAt == null);
if (unexpectedOldCredential) throw new Error(`Superseded production Console application credential remained active: ${unexpectedOldCredential.id}`);

const tokens = await request(`/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens`, { bearer: applicationCredential });
if (tokens.response.status !== 200 || !Array.isArray(tokens.payload?.data)) throw new Error("Could not verify production Console Core token metadata after cleanup");
const currentToken = tokens.payload.data.find((entry) => entry?.id === currentTokenId && entry?.revokedAt == null && (!entry?.expiresAt || Date.parse(entry.expiresAt) > Date.now()));
if (!currentToken) throw new Error("Current production Console Core token is not active after cleanup");
const unexpectedOldToken = tokens.payload.data.find((entry) => oldTokenIds.includes(entry?.id) && entry?.revokedAt == null);
if (unexpectedOldToken) throw new Error(`Superseded production Console Core token remained active: ${unexpectedOldToken.id}`);

console.log(JSON.stringify({
  ok: true,
  environment: "production",
  applicationId,
  currentCredentialId,
  revokedCredentialCount: oldCredentialIds.length,
  corePrincipalId: principalId,
  currentCoreTokenId: currentTokenId,
  revokedCoreTokenCount: oldTokenIds.length,
  plaintextLogged: false,
}, null, 2));

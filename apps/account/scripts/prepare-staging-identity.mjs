import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { STAGING_EXPECTATIONS } from "../../../infra/scripts/staging-expectations.mjs";

export const ACCOUNT_APPLICATION_ID = "app_lifespace_account_staging";
export const ACCOUNT_APPLICATION_SCOPES = ["profile:read", "spaces:read", "spaces:manage"];
const ACCOUNT_APPLICATION_NAME = "LifeSpace Account staging";

export function requireApplicationPolicy(app) {
  if (!app || app.id !== ACCOUNT_APPLICATION_ID || app.name !== ACCOUNT_APPLICATION_NAME
    || app.status !== "active" || app.trustedBackend !== true || app.accessTokenTtlSeconds !== 900
    || !Array.isArray(app.allowedScopes) || app.allowedScopes.length !== ACCOUNT_APPLICATION_SCOPES.length
    || ACCOUNT_APPLICATION_SCOPES.some(scope => !app.allowedScopes.includes(scope))) {
    throw new Error("Account Application policy mismatch; refusing to silently widen or restore authority");
  }
  return app;
}
export function requireAudience(entries, expectedAudience) {
  if (!Array.isArray(entries)) throw new Error("Invalid Account Audience list");
  const active = entries.filter(entry => entry.audience === expectedAudience && entry.status === "active");
  if (active.length > 1) throw new Error("Duplicate active Account Audience");
  return active[0] ?? null;
}
export function identifyCredentialRotation(rows, issued) {
  if (!Array.isArray(rows) || typeof issued !== "string" || !/^lsa_[A-Za-z0-9_-]{30,}$/u.test(issued)) {
    throw new Error("Account credential metadata is invalid");
  }
  const active = rows.filter((row) => row?.status === "active" && row.revokedAt == null);
  const suffix = issued.slice(-8);
  const current = active.filter((row) => row.secretSuffix === suffix
    && typeof row.id === "string" && /^apc_[A-Za-z0-9_-]+$/u.test(row.id));
  if (current.length !== 1 || active.some((row) =>
    typeof row.id !== "string" || !/^apc_[A-Za-z0-9_-]+$/u.test(row.id))) {
    throw new Error("Cannot uniquely identify newly issued Account application credential");
  }
  return {
    currentId: current[0].id,
    oldIds: active.filter((row) => row.id !== current[0].id).map((row) => row.id),
  };
}
async function main() {
  const issuer = "https://auth-staging.aisr.online";
  const bootstrap = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET || "";
  const audience = process.env.LIFESPACE_STAGING_ACCOUNT_ACCESS_AUD || "";
  const envFile = process.env.GITHUB_ENV || "";
  if (bootstrap.length < 32 || !/^[A-Za-z0-9]{30,128}$/u.test(audience) || !envFile) {
    throw new Error("Staging bootstrap, exact Account Audience and private GITHUB_ENV are required");
  }
  console.log("::add-mask::" + bootstrap);
  async function request(path, { method = "GET", body } = {}) {
    const response = await fetch(issuer + path, {
      method,
      headers: { accept: "application/json", "x-bootstrap-secret": bootstrap,
        ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  }
  const stateResponse = await fetch(issuer + "/api/v1/status", { headers: { accept: "application/json" } });
  const state = (await stateResponse.json().catch(() => null))?.data;
  if (!stateResponse.ok || state?.environment !== "staging"
    || state?.contractVersion !== STAGING_EXPECTATIONS.identity.contractVersion
    || Number(state?.schemaVersion) !== STAGING_EXPECTATIONS.identity.schemaVersion) {
    throw new Error("Identity Staging must already be deployed from approved platform release");
  }
  const path = "/bootstrap/v1/applications/" + encodeURIComponent(ACCOUNT_APPLICATION_ID);
  const existing = await request(path);
  let created = false, issued;
  if (existing.response.status === 404) {
    const result = await request("/bootstrap/v1/applications", {
      method: "POST",
      body: {
        id: ACCOUNT_APPLICATION_ID, name: ACCOUNT_APPLICATION_NAME,
        trustedBackend: true, allowedScopes: ACCOUNT_APPLICATION_SCOPES,
        accessTokenTtlSeconds: 900,
      },
    });
    if (result.response.status !== 201 || result.payload?.data?.id !== ACCOUNT_APPLICATION_ID) {
      throw new Error("Account Application creation failed");
    }
    issued = result.payload?.data?.clientSecret;
    const readBack = await request(path);
    if (readBack.response.status !== 200) throw new Error("Created Account Application cannot be re-read");
    requireApplicationPolicy(readBack.payload?.data);
    created = true;
  } else {
    if (existing.response.status !== 200) throw new Error("Cannot read Account Application");
    requireApplicationPolicy(existing.payload?.data);
    // Overlap active credentials while staging switches Workers. Never revoke
    // previous active credentials until a separately verified cutover.
    const result = await request(path + "/credentials", { method: "POST" });
    if (result.response.status !== 201) throw new Error("Account credential rotation failed");
    issued = result.payload?.data?.clientSecret;
  }
  if (typeof issued !== "string" || !/^lsa_[A-Za-z0-9_-]{30,}$/u.test(issued)
    || /[\r\n]/u.test(issued)) {
    throw new Error("Identity did not return a valid one-time Account credential");
  }
  console.log("::add-mask::" + issued);
  const audiencePath = path + "/access-audiences";
  const registered = await request(audiencePath);
  if (registered.response.status !== 200) throw new Error("Cannot inspect Account Access Audience");
  let current = requireAudience(registered.payload?.data, audience);
  if (!current) {
    const add = await request(audiencePath, {
      method: "POST", body: { audience },
    });
    if (![200, 201].includes(add.response.status)) throw new Error("Account Audience registration failed");
    current = requireAudience([add.payload?.data], audience);
  }
  if (!current) throw new Error("Account Audience could not be verified active");
  const metadata = await request(path + "/credentials");
  if (metadata.response.status !== 200) throw new Error("Could not inspect Account credential rotation");
  const rotation = identifyCredentialRotation(metadata.payload?.data, issued);
  appendFileSync(envFile, "LIFESPACE_STAGING_ACCOUNT_APPLICATION_CREDENTIAL=" + issued + "\n");
  appendFileSync(envFile, "LIFESPACE_STAGING_ACCOUNT_CURRENT_CREDENTIAL_ID=" + rotation.currentId + "\n");
  appendFileSync(envFile, "LIFESPACE_STAGING_ACCOUNT_OLD_CREDENTIAL_IDS=" + rotation.oldIds.join(",") + "\n");
  console.log(JSON.stringify({
    ok: true, environment: "staging", applicationId: ACCOUNT_APPLICATION_ID,
    created, credentialRotated: !created, plaintextLogged: false,
    supersededActiveCredentialCount: rotation.oldIds.length,
    audienceActive: true, noPlatformAdminScope: true,
    identitySchemaVersion: state.schemaVersion, noProductionChanges: true,
  }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

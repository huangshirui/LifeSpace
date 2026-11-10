// First-time, Owner-confirmed Production Account Application & Audience setup.
// Identity remains the only authority; no shadow Account database or user map.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PRODUCTION_EXPECTATIONS } from "../../../infra/scripts/production-expectations.mjs";

export const PRODUCTION_ACCOUNT_APP_ID = "app_lifespace_account";
export const PRODUCTION_ACCOUNT_SCOPES = Object.freeze([
  "profile:read", "profile:write", "spaces:read", "spaces:write", "spaces:manage",
]);

export function requireProductionAccountApplication(app) {
  if (!app || app.id !== PRODUCTION_ACCOUNT_APP_ID
    || app.name !== "LifeSpace Account production"
    || app.status !== "active" || app.trustedBackend !== true
    || app.accessTokenTtlSeconds !== 900
    || !Array.isArray(app.allowedScopes)
    || app.allowedScopes.length !== PRODUCTION_ACCOUNT_SCOPES.length
    || !PRODUCTION_ACCOUNT_SCOPES.every(s => app.allowedScopes.includes(s))) {
    throw new Error("Production Account Application has unexpected authority; no implicit scope migration");
  }
  return app;
}

async function main() {
  const bootstrap = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET || "";
  const audience = process.env.LIFESPACE_PRODUCTION_ACCOUNT_ACCESS_AUD || "";
  const githubEnv = process.env.GITHUB_ENV || "";
  if (bootstrap.length < 32 || !/^[a-zA-Z0-9]{30,128}$/u.test(audience) || !githubEnv) {
    throw new Error("Production Bootstrap secret, verified audience and private GITHUB_ENV are required");
  }
  console.log("::add-mask::" + bootstrap);
  const issuer = "https://auth.aisr.online";
  async function api(path, method = "GET", body) {
    const response = await fetch(issuer + path, {
      method,
      headers: { accept: "application/json", "x-bootstrap-secret": bootstrap,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json().catch(() => null))?.data };
  }
  const statusResponse = await fetch(issuer + "/api/v1/status", {
    headers: { accept: "application/json" },
  });
  const status = (await statusResponse.json().catch(() => null))?.data;
  if (!statusResponse.ok || status?.environment !== "production"
    || status.contractVersion !== PRODUCTION_EXPECTATIONS.identity.contractVersion
    || Number(status.schemaVersion) !== PRODUCTION_EXPECTATIONS.identity.schemaVersion) {
    throw new Error("Production Identity must first match reviewed Platform Production release");
  }
  const path = "/bootstrap/v1/applications/" + PRODUCTION_ACCOUNT_APP_ID;
  const existing = await api(path);
  if (existing.status !== 404) {
    // An existing application may have a still-active credential. Do not mint
    // a second or revoke any credential during first-time bootstrapping.
    if (existing.status === 200) requireProductionAccountApplication(existing.data);
    throw new Error("Production Account Application already exists; use explicit recovery, not bootstrap");
  }
  const created = await api("/bootstrap/v1/applications", "POST", {
    id: PRODUCTION_ACCOUNT_APP_ID, name: "LifeSpace Account production",
    trustedBackend: true, allowedScopes: [...PRODUCTION_ACCOUNT_SCOPES],
    accessTokenTtlSeconds: 900,
  });
  if (created.status !== 201 || created.data?.id !== PRODUCTION_ACCOUNT_APP_ID) {
    throw new Error("Production Account Application bootstrap failed");
  }
  const credential = created.data.clientSecret;
  if (typeof credential !== "string" || !/^lsa_[a-zA-Z0-9_-]{30,}$/u.test(credential)
    || /[\r\n]/u.test(credential)) throw new Error("Invalid one-time trusted backend credential");
  console.log("::add-mask::" + credential);
  const checked = await api(path);
  if (checked.status !== 200) throw new Error("Created Account Application cannot be read back");
  requireProductionAccountApplication(checked.data);
  const registered = await api(path + "/access-audiences");
  if (registered.status !== 200 || !Array.isArray(registered.data)) {
    throw new Error("Cannot inspect Production Account Audience");
  }
  const matches = registered.data.filter(x => x.audience === audience && x.status === "active");
  if (matches.length > 1) throw new Error("Duplicate active Account audience");
  if (!matches.length) {
    const added = await api(path + "/access-audiences", "POST", { audience });
    if (![200, 201].includes(added.status) || added.data?.audience !== audience
      || added.data?.status !== "active") throw new Error("Account Audience registration failed");
  }
  // The one-time value is only passed inside the protected ephemeral Actions runner.
  // It must never be printed, stored in a public artifact or checked into git.
  appendFileSync(githubEnv,
    "LIFESPACE_PRODUCTION_ACCOUNT_APPLICATION_CREDENTIAL=" + credential + "\n");
  console.log(JSON.stringify({ ok: true, applicationCreated: true,
    audienceRegistered: true, noPlatformAdminScope: true, secretLogged: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

import { appendFileSync } from "node:fs";
import process from "node:process";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

const env = process.env;
const identityBase = (env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const credentialRef = env.LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF ?? "";
const targetSpaceId = env.LIFESPACE_EXTERNAL_TARGET_SPACE_ID ?? "";
const githubOutput = env.GITHUB_OUTPUT ?? "";
const githubSummary = env.GITHUB_STEP_SUMMARY ?? "";
const runId = (env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const runAttempt = (env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^0-9A-Za-z_-]/gu, "_");
const applicationId = `app_staging_external_provision_${runId}_${runAttempt}`;
const providerKey = "notion";
const coreDir = new URL("../../apps/core/", import.meta.url);

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID ?? "",
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF: credentialRef,
  LIFESPACE_EXTERNAL_TARGET_SPACE_ID: targetSpaceId,
})) {
  if (!value) throw new Error(`${name} is required`);
}
if (identityBase !== "https://auth-staging.aisr.online" || coreBase !== "https://core-staging.aisr.online") {
  throw new Error("External Source provisioning is staging-only and must use the canonical staging hosts");
}
if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_STAGING_BOOTSTRAP_SECRET must contain at least 32 characters");
if (!/^spc_[0-9a-f]{32}$/u.test(targetSpaceId)) throw new Error("Target Space must use the canonical spc_<32 lowercase hex> form");
if (!/^[A-Za-z0-9_-]{1,128}$/u.test(credentialRef)) throw new Error("Configured credential reference is invalid");

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}
function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
async function d1(command) {
  return executeStagingD1Sql({ cwd: coreDir, sql: command });
}
function rows(results) {
  return results.flatMap((result) => result.results ?? []);
}
async function request(base, path, { method = "GET", bearer, bootstrap, body, timeoutMs = 30000 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(bootstrap ? { "x-bootstrap-secret": bootstrapSecret } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { payload = text; }
  }
  return { response, payload };
}
function requireData(result, expectedStatus, label) {
  if (result.response.status !== expectedStatus || !result.payload?.data) {
    throw new Error(`${label} failed: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload.data;
}
async function matchingSources() {
  return rows(await d1(`SELECT id,status FROM external_sources WHERE space_id=${sql(targetSpaceId)} AND provider_key=${sql(providerKey)} AND credential_ref=${sql(credentialRef)} ORDER BY created_at DESC,id`));
}
function publishResult(sourceId, reused) {
  if (githubOutput) appendFileSync(githubOutput, `source_id=${sourceId}\nreused=${reused ? "1" : "0"}\n`, "utf8");
  if (githubSummary) appendFileSync(githubSummary, `\n## Staging External Source provisioning\n\n- Space: \`${targetSpaceId}\`\n- Provider: \`${providerKey}\`\n- Source: \`${sourceId}\`\n- Reused existing active Source: ${reused ? "yes" : "no"}\n- Provider credential plaintext was not exposed to the workflow or browser.\n- Production was not targeted.\n`, "utf8");
  console.log(JSON.stringify({ ok: true, environment: "staging", spaceId: targetSpaceId, providerKey, sourceId, reused }));
}

const space = rows(await d1(`SELECT id FROM spaces WHERE id=${sql(targetSpaceId)} AND deleted_at IS NULL`));
if (space.length !== 1) throw new Error(`Target staging Space was not found or is not active: ${targetSpaceId}`);
const existing = await matchingSources();
const active = existing.filter((row) => row.status === "active");
if (active.length > 1) throw new Error(`Multiple active matching External Sources already exist for ${targetSpaceId}; manual reconciliation is required`);
if (active.length === 1) {
  publishResult(active[0].id, true);
  process.exit(0);
}

let applicationSecret = "";
let principalId = "";
let tokenId = "";
let serviceToken = "";
const cleanupWarnings = [];

async function cleanup() {
  if (applicationSecret && principalId && tokenId) {
    try {
      const revoked = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens/${encodeURIComponent(tokenId)}`, {
        method: "DELETE",
        bearer: applicationSecret,
      });
      if (![204, 404].includes(revoked.response.status)) cleanupWarnings.push(`Service token revoke returned HTTP ${revoked.response.status}`);
    } catch (error) {
      cleanupWarnings.push(`Service token revoke failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (applicationSecret && principalId) {
    try {
      const disabled = await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}`, {
        method: "PATCH",
        bearer: applicationSecret,
        body: { status: "disabled" },
      });
      if (![200, 404].includes(disabled.response.status)) cleanupWarnings.push(`Service principal disable returned HTTP ${disabled.response.status}`);
    } catch (error) {
      cleanupWarnings.push(`Service principal disable failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (applicationSecret) {
    try {
      const disabledApp = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
        method: "PATCH",
        bootstrap: true,
        body: { status: "disabled" },
      });
      if (![200, 404].includes(disabledApp.response.status)) cleanupWarnings.push(`Temporary application disable returned HTTP ${disabledApp.response.status}`);
    } catch (error) {
      cleanupWarnings.push(`Temporary application disable failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

let provisionedSourceId = "";
try {
  const application = requireData(await request(identityBase, "/bootstrap/v1/applications", {
    method: "POST",
    bootstrap: true,
    body: {
      id: applicationId,
      name: `LifeSpace staging External provision ${runId}/${runAttempt}`,
      allowedScopes: ["models:manage"],
      trustedBackend: true,
      accessTokenTtlSeconds: 900,
    },
  }), 201, "Temporary staging application creation");
  applicationSecret = application.clientSecret ?? "";
  if (!applicationSecret) throw new Error("Temporary staging application did not return a client secret");
  mask(applicationSecret);

  const principal = requireData(await request(identityBase, "/api/v1/service-principals", {
    method: "POST",
    bearer: applicationSecret,
    body: {
      displayName: `Staging External Source provision ${runId}/${runAttempt}`,
      description: "Ephemeral staging-only non-interactive Model Admin for External Source provisioning",
      maxScopes: ["models:manage"],
    },
  }), 201, "Temporary Model Admin service principal creation");
  principalId = principal.id ?? "";
  if (!principalId) throw new Error("Temporary service principal did not return an id");

  const token = requireData(await request(identityBase, `/api/v1/service-principals/${encodeURIComponent(principalId)}/tokens`, {
    method: "POST",
    bearer: applicationSecret,
    body: {
      label: `Staging External Source provision ${runId}/${runAttempt}`,
      scopes: ["models:manage"],
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  }), 201, "Temporary Model Admin token creation");
  serviceToken = token.token ?? "";
  tokenId = token.id ?? "";
  if (!serviceToken || !tokenId) throw new Error("Temporary Model Admin token response is incomplete");
  mask(serviceToken);

  try {
    const provisioned = await request(coreBase, "/api/v1/model-admin/external-sources", {
      method: "POST",
      bearer: serviceToken,
      body: { spaceId: targetSpaceId, providerKey, credentialRef },
      timeoutMs: 60000,
    });
    const source = requireData(provisioned, 201, "External Source provisioning");
    provisionedSourceId = source.id ?? "";
    if (!/^exs_[0-9a-f]{32}$/u.test(provisionedSourceId)) throw new Error("External Source provisioning returned an invalid source id");
  } catch (error) {
    const afterUnknown = (await matchingSources()).filter((row) => row.status === "active");
    if (afterUnknown.length === 1) {
      provisionedSourceId = afterUnknown[0].id;
      console.log("Provision request ended without a confirmed response; verified one active matching Source from staging metadata and will not retry the write");
    } else {
      throw error;
    }
  }

  const verified = (await matchingSources()).filter((row) => row.status === "active" && row.id === provisionedSourceId);
  if (verified.length !== 1) throw new Error("Provisioned External Source did not converge to one active staging row");
} finally {
  await cleanup();
}

if (cleanupWarnings.length) {
  throw new Error(`External Source was provisioned but temporary authority cleanup was incomplete: ${cleanupWarnings.join("; ")}`);
}
publishResult(provisionedSourceId, false);

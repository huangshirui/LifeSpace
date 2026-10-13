import { runExternalProviderSmoke } from "./external-provider-smoke.mjs";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

const env = process.env;
if (env.LIFESPACE_EXTERNAL_PROVIDER_ACTIVE !== "1" || env.LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED !== "1") throw new Error("Explicit synthetic staging provider acceptance is required");
const base = env.LIFESPACE_CORE_STAGING_URL;
if (!base || new URL(base).hostname !== "core-staging.aisr.online") throw new Error("External smoke must target canonical staging Core");
for (const name of ["LIFESPACE_STAGING_USER_BEARER", "LIFESPACE_STAGING_MODEL_ADMIN_BEARER", "LIFESPACE_STAGING_SPACE_ID", "LIFESPACE_STAGING_SMOKE_APPLICATION_ID", "LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID", "LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF"]) if (!env[name]) throw new Error(`${name} is required`);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const coreDir = new URL("../../apps/core/", import.meta.url);
const sql = command => executeStagingD1Sql({ cwd: coreDir, sql: command });
const marker = `${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}_${crypto.randomUUID().slice(0, 8)}`.replace(/[^a-z0-9_]/g, "_").slice(0, 45);
const space = env.LIFESPACE_STAGING_SPACE_ID, app = env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID;

const result = await runExternalProviderSmoke({
  spaceId: space, resourceId: env.LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID, credentialRef: env.LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF, marker,
  async request(path, { method, body, role }) {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${role === "admin" ? env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER : env.LIFESPACE_STAGING_USER_BEARER}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    return { status: response.status, payload: response.status === 204 ? null : await response.json() };
  },
  async allowModels(keys) {
    const now = new Date().toISOString();
    for (const key of keys) await sql(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at) VALUES(${quote(app)},${quote(key)},'write','service',${quote(env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID)},${quote(now)},${quote(now)})`);
  },
  async verifyScheduledRefresh(registration) {
    if (!registration || !/^ext_[0-9a-f]{32}$/.test(registration)) throw new Error("Verified smoke registration is required for scheduled refresh acceptance");
    const condition = `model_key=${quote(registration)} AND space_id=${quote(space)}`;
    const observed = async () => (await sql(`SELECT schema_observed_at,status,last_error_code FROM external_models WHERE ${condition}`)).flatMap(result => result.results ?? [])[0];
    const before = await observed();
    if (!before) throw new Error("Smoke registration metadata is missing");
    await sql(`UPDATE external_models SET next_refresh_at='2000-01-01T00:00:00.000Z' WHERE ${condition}`);
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const current = await observed();
      if (current?.schema_observed_at > before.schema_observed_at && current.status === "active" && !current.last_error_code) return;
    }
    throw new Error("Real Scheduled External refresh did not converge within the 150-second staging smoke window");
  },
  async cleanupMetadata({ source, externalKey, nativeKey }) {
    // Only this run's verified Space + newly created Source. Never remove a
    // pre-existing provider registration, audit, Registry history or provider data.
    if (source) await sql(`DELETE FROM external_record_identities WHERE space_id=${quote(space)} AND model_key IN (SELECT model_key FROM external_models WHERE space_id=${quote(space)} AND source_id=${quote(source)} AND definition_key=${quote(externalKey)}); DELETE FROM external_models WHERE space_id=${quote(space)} AND source_id=${quote(source)} AND definition_key=${quote(externalKey)}; DELETE FROM external_sources WHERE id=${quote(source)} AND space_id=${quote(space)};`);
    await sql(`DELETE FROM application_model_access WHERE application_id=${quote(app)} AND model_key IN (${quote(externalKey)},${quote(nativeKey)})`);
  },
});
console.log(JSON.stringify({ ...result, providerRevision: env.LIFESPACE_EXTERNAL_PROVIDER_REVISION, latencyScope: "staging runner observations only; not an APAC SLO or synthetic 429 assertion" }));

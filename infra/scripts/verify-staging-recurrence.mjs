import { runRecurrenceSmoke } from "./recurrence-staging-smoke.mjs";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

const env = process.env, base = env.LIFESPACE_CORE_STAGING_URL;
if (!base || new URL(base).hostname !== "core-staging.aisr.online") throw new Error("Recurrence acceptance must target canonical staging Core");
for (const name of ["LIFESPACE_STAGING_USER_BEARER", "LIFESPACE_STAGING_MODEL_ADMIN_BEARER", "LIFESPACE_STAGING_SPACE_ID", "LIFESPACE_STAGING_SMOKE_APPLICATION_ID", "LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID"]) if (!env[name]) throw new Error(`${name} is required`);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sql = command => executeStagingD1Sql({ cwd: new URL("../../apps/core/", import.meta.url), sql: command });
const space = env.LIFESPACE_STAGING_SPACE_ID, app = env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID;
const marker = `${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}_${crypto.randomUUID().slice(0, 8)}`.replace(/[^a-z0-9_]/g, "_").slice(0, 45);
const result = await runRecurrenceSmoke({ marker, spaceId: space,
  async request(path, { method, body, role }) {
    const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${role === "admin" ? env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER : env.LIFESPACE_STAGING_USER_BEARER}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
    return { status: response.status, payload: response.status === 204 ? null : await response.json() };
  },
  async allowModel(key) {
    const now = new Date().toISOString();
    await sql(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at) VALUES(${quote(app)},${quote(key)},'write','service',${quote(env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID)},${quote(now)},${quote(now)})`);
  },
  async tasksForPlan(id) {
    return (await sql(`SELECT o.task_record_id id,r.version FROM recurrence_occurrences o JOIN resource_records r ON r.id=o.task_record_id WHERE o.plan_record_id=${quote(id)} AND r.space_id=${quote(space)} AND r.deleted_at IS NULL ORDER BY o.due_date,o.id`)).flatMap(result => result.results ?? []);
  },
  async cleanupAccess(key) { await sql(`DELETE FROM application_model_access WHERE application_id=${quote(app)} AND model_key=${quote(key)}`); },
});
console.log(JSON.stringify(result));

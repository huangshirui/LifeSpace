import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { getRuntimeModel, publishModelDefinition } from "../src/model-registry";
import { createGenericResource, getGenericResource, updateGenericResource } from "../src/generic-resource";
import { executeWorkflowAction } from "../src/workflow";
import { executeNativeModelBatch } from "../src/native-model-batch";
import { rollRecurrenceWindow } from "../src/recurrence-runtime";
import { countingDatabase, type DatabaseCost } from "./support/counting-database";
import { createApp } from "../src/app";

async function fixture() {
  const db = (env as unknown as { DB: D1Database }).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`, userId = `usr_${suffix}`, modelKey = `plan_${suffix.slice(0, 8)}`, clientId = `app_${suffix}`;
  const bindings = { DB: db, ENVIRONMENT: "test", RECURRENCE_WINDOW_DAYS: "5", CORE_IDENTITY_SHARED_SECRET: "test-internal",
    IDENTITY: { fetch: async (_url: string, init: RequestInit) => { const body = JSON.parse(String(init.body)); return Response.json({ data: { roots: body.roots.map((root: any) => ({ ...root, active: true, scopes: ["resources:read", "resources:write"] })) } }); } } } as unknown as Bindings;
  const principal: Principal = { type: "user", id: userId, clientId, scopes: ["resources:read", "resources:write"], tokenId: suffix };
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,'Asia/Shanghai')").bind(spaceId, "Recurrence", userId, timestamp, timestamp),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,'owner',?,?)").bind(`mem_${suffix}`, spaceId, userId, timestamp, timestamp),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,'Owner',?,?)").bind(`per_${suffix}`, spaceId, userId, timestamp, timestamp),
    ...["task", modelKey].map(key => db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,'write','user',?)").bind(clientId, key, userId)),
  ]);
  await publishModelDefinition(bindings, { type: "service", id: "svc_test", clientId: "platform", scopes: ["models:manage"], tokenId: suffix }, {
    definitionVersion: 1, key: modelKey, display: { singular: "Plan", plural: "Plans" }, access: ["read", "write"],
    fields: { title: { type: "string", required: true }, firstDue: { type: "date", nullable: true }, repeat: { type: "recurrence_rule", nullable: true }, status: { type: "enum", values: ["active", "paused", "ended"], required: true }, end: { type: "date", nullable: true }, who: { type: "person", nullable: true } },
    defaults: { status: "active" }, capabilities: { recurrence: { ruleField: "repeat", firstDueDateField: "firstDue", statusField: "status", endDateField: "end", task: { nameField: "title", subjectField: "who" } } },
  }, "initial");
  const planModel = (await getRuntimeModel(bindings, modelKey))!, taskModel = (await getRuntimeModel(bindings, "task"))!;
  const fresh = () => ({ ...principal, tokenId: crypto.randomUUID() });
  const tasks = async (planId: string) => (await db.prepare("SELECT t.*,o.id occurrenceId,o.outcome FROM mdl_task t JOIN recurrence_occurrences o ON o.task_record_id=t.record_id WHERE o.plan_record_id=? ORDER BY o.due_date,o.id").bind(planId).all<any>()).results;
  return { db, bindings, principal, fresh, spaceId, modelKey, planModel, taskModel, tasks, personId: `per_${suffix}` };
}
const completion = { mode: "after_completion", interval: { value: 30, unit: "day" } };

describe("Metadata-driven Recurrence runtime", () => {
  it("requires firstDueDate only with a rule; creates Task subject/link/occurrence atomically", async () => {
    const f = await fixture();
    await expect(createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Invalid", repeat: completion })).rejects.toThrow("firstDueDate");
    const plain = await createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Plain" });
    expect(await f.tasks(plain.id)).toHaveLength(0);
    const plan = await createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Filter", firstDue: "2026-11-01", repeat: completion, who: f.personId });
    const tasks = await f.tasks(plan.id); expect(tasks).toHaveLength(1); expect(tasks[0].dueDate).toBe("2026-11-01");
    expect(JSON.parse(tasks[0].subject)).toEqual({ kind: "person", personId: f.personId });
    expect((await f.db.prepare("SELECT COUNT(*) n FROM semantic_relations WHERE target_record_id=? AND predicate='generated_from'").bind(plan.id).first<any>()).n).toBe(1);
    const read = await getGenericResource(f.bindings, f.spaceId, f.planModel, plan.id);
    expect(read!.data.repeat).toEqual(completion);
  });
  it("advances from actual completion; reopen and concurrent retries create one successor", async () => {
    const f = await fixture();
    const plan = await createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Regimen", firstDue: "2026-11-01", repeat: completion });
    const task = (await f.tasks(plan.id))[0];
    const attempts = await Promise.allSettled([1, 2].map(() => executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, task.record_id, "complete", 1)));
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await f.tasks(plan.id)).toHaveLength(2);
    const completed = await getGenericResource(f.bindings, f.spaceId, f.taskModel, task.record_id);
    const reopened = await executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, task.record_id, "reopen", completed!.version);
    await executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, task.record_id, "complete", reopened.version);
    expect(await f.tasks(plan.id)).toHaveLength(2);
    expect((await f.tasks(plan.id))[1].dueDate).not.toBe("2026-12-01");
  });
  it("pause completion records anchor; resume creates one next Task; cancel requires explicit skip", async () => {
    const f = await fixture();
    const plan = await createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Maintenance", firstDue: "2026-11-01", repeat: completion });
    const first = (await f.tasks(plan.id))[0];
    const paused = await updateGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, plan.id, 1, { status: "paused" });
    await executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, first.record_id, "complete", 1);
    expect(await f.tasks(plan.id)).toHaveLength(1);
    await expect(executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, first.record_id, "skip-occurrence", 2)).rejects.toThrow("completed occurrence");
    await updateGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, plan.id, paused.version, { status: "active" });
    expect(await f.tasks(plan.id)).toHaveLength(2);
    const second = (await f.tasks(plan.id)).find(t => t.outcome === "active");
    const cancelled = await executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, second.record_id, "cancel", 1);
    expect(await f.tasks(plan.id)).toHaveLength(2);
    await executeWorkflowAction(f.bindings, f.fresh(), f.spaceId, f.taskModel, second.record_id, "skip-occurrence", cancelled.version);
    expect(await f.tasks(plan.id)).toHaveLength(3);
  });
  it("calendar does not wait for completion; endDate bounds tasks; rule edits cancel only future tasks", async () => {
    const f = await fixture();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const plan = await createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Calendar", firstDue: today, repeat: { mode: "calendar", frequency: "daily", interval: 1 } });
    expect(await f.tasks(plan.id)).toHaveLength(6);
    await updateGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, plan.id, 1, { repeat: { mode: "calendar", frequency: "daily", interval: 2 } });
    const tasks = await f.tasks(plan.id);
    expect(tasks.filter(t => t.status === "cancelled")).toHaveLength(5);
    expect(tasks.filter(t => t.dueDate === today)).toHaveLength(1);
    const bounded = await createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "End", firstDue: today, end: today, repeat: { mode: "calendar", frequency: "daily", interval: 1 } });
    expect(await f.tasks(bounded.id)).toHaveLength(1);
  });
  it("20-plan batch stays bounded and current authority revocation blocks rolling generation", async () => {
    const f = await fixture(); const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] };
    const bindings = { ...f.bindings, DB: countingDatabase(f.db, cost) };
    const result = await executeNativeModelBatch(bindings, f.fresh(), f.spaceId, { operations: Array.from({ length: 20 }, (_, i) => ({ operation: "create", modelKey: f.modelKey, data: { title: `Plan ${i}`, firstDue: "2026-11-01", repeat: completion, who: f.personId } })) });
    expect(result.items).toHaveLength(20);
    expect(cost.roundTrips).toBeLessThanOrEqual(8);
    expect((await f.db.prepare("SELECT COUNT(DISTINCT c.change_set_id) n FROM resource_changes c JOIN recurrence_occurrences o ON o.task_record_id=c.record_id WHERE c.space_id=? AND c.operation='create'").bind(f.spaceId).first<any>()).n).toBe(1);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM recurrence_occurrences WHERE plan_record_id IN (SELECT plan_record_id FROM recurrence_plans WHERE space_id=?)").bind(f.spaceId).first<any>()).n).toBe(20);
    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key='task'").bind(f.principal.clientId).run();
    await expect(createGenericResource(f.bindings, f.fresh(), f.spaceId, f.planModel, { title: "Denied", firstDue: "2026-11-01", repeat: completion })).rejects.toThrow();
    expect(await rollRecurrenceWindow(f.bindings)).toBe(0);
  });
  it("reserves completion-based first Tasks when a mixed batch also expands calendar windows", async () => {
    const f = await fixture();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const result = await executeNativeModelBatch(f.bindings, f.fresh(), f.spaceId, { operations: Array.from({ length: 20 }, (_, index) => ({ operation: "create", modelKey: f.modelKey, data: { title: `Mixed ${index}`, firstDue: index === 0 ? today : "2026-11-01", repeat: index === 0 ? { mode: "calendar", frequency: "daily", interval: 1 } : completion } })) });
    for (const item of result.items) expect(await f.tasks(String(item.recordId))).toHaveLength(1);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM recurrence_occurrences WHERE plan_record_id IN (SELECT plan_record_id FROM recurrence_plans WHERE space_id=?)").bind(f.spaceId).first<any>()).n).toBe(20);
  });
  it("rolls through indexed due plans among 1000 parked plans and retries without duplicates", async () => {
    const f = await fixture();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const b = { ...f.bindings, RECURRENCE_WINDOW_DAYS: "0" };
    const plan = await createGenericResource(b, f.fresh(), f.spaceId, f.planModel, { title: "Rolling", firstDue: today, repeat: { mode: "calendar", frequency: "daily", interval: 1 } });
    const prefix = `rec_scale_${crypto.randomUUID().replaceAll("-", "")}_`;
    const columns = (await f.db.prepare("PRAGMA table_info(resource_records)").all<{ name: string }>()).results.map(row => row.name).filter(name => name !== "id");
    const sqlColumns = columns.map(name => `"${name}"`).join(",");
    await f.db.batch([
      f.db.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<1000)
        INSERT INTO resource_records(id,${sqlColumns}) SELECT ?||n.value,${columns.map(name => `r."${name}"`).join(",")} FROM resource_records r,n WHERE r.id=?`).bind(prefix, plan.id),
      f.db.prepare(`INSERT INTO recurrence_plans(plan_record_id,space_id,model_key,revision,config_json,version,principal_type,principal_id,application_id,scopes_json,next_materialize_date,next_materialize_at,stopped)
        SELECT r.id,p.space_id,p.model_key,p.revision,p.config_json,1,p.principal_type,p.principal_id,p.application_id,p.scopes_json,'2099-01-01','2099-01-01T00:00:00.000Z',0
        FROM resource_records r,recurrence_plans p WHERE p.plan_record_id=? AND r.id LIKE ?`).bind(plan.id, `${prefix}%`),
    ]);
    const explain = await f.db.prepare("EXPLAIN QUERY PLAN SELECT * FROM recurrence_plans WHERE next_materialize_at IS NOT NULL AND next_materialize_at<=? ORDER BY next_materialize_at,plan_record_id LIMIT 20").bind("2026-12-01T00:00:00.000Z").all<{ detail: string }>();
    expect(explain.results.some(row => row.detail.includes("idx_recurrence_due"))).toBe(true);
    await f.db.prepare("UPDATE recurrence_plans SET next_materialize_at='2099-01-01T00:00:00.000Z' WHERE space_id<>? AND next_materialize_at IS NOT NULL").bind(f.spaceId).run();
    const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] };
    const bindings = { ...b, DB: countingDatabase(f.db, cost) };
    await getRuntimeModel(bindings, f.modelKey); cost.roundTrips = 0; cost.rowsRead = 0; cost.sql = [];
    const tomorrow = new Date(Date.now() + 86400000).toISOString();
    await rollRecurrenceWindow(bindings, tomorrow);
    expect(await f.tasks(plan.id)).toHaveLength(2);
    expect(cost.roundTrips).toBeLessThanOrEqual(8);
    expect(cost.rowsRead).toBeLessThan(1000);
    await rollRecurrenceWindow(bindings, tomorrow);
    expect(await f.tasks(plan.id)).toHaveLength(2);
  });
  it("does not preserve disabled Identity authority and rejects forged internal executors", async () => {
    const f = await fixture();
    const disabled = { ...f.bindings, IDENTITY: { fetch: async (_url: string, init: RequestInit) => Response.json({ data: { roots: JSON.parse(String(init.body)).roots.map((root: any) => ({ ...root, active: false, scopes: [] })) } }) } } as unknown as Bindings;
    await expect(createGenericResource(disabled, f.fresh(), f.spaceId, f.planModel, { title: "Disabled", firstDue: "2026-11-01", repeat: completion })).rejects.toThrow("disabled");
    await expect(createGenericResource(f.bindings, { ...f.fresh(), actor: { type: "service", id: "svc_lifespace_recurrence" } }, f.spaceId, f.taskModel, { name: "Forged" })).rejects.toThrow("Delegation");
  });
  it("rolls back Plan, Task, relation and occurrence when current authority is revoked at commit", async () => {
    const f = await fixture(), cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] };
    let revoked = false;
    const db = countingDatabase(f.db, cost, async sql => {
      if (!revoked && sql.some(statement => statement.includes("INSERT INTO resource_records"))) {
        revoked = true;
        await f.db.prepare("UPDATE space_memberships SET deleted_at=? WHERE space_id=?").bind(new Date().toISOString(), f.spaceId).run();
      }
    });
    await expect(createGenericResource({ ...f.bindings, DB: db }, f.fresh(), f.spaceId, f.planModel, { title: "Atomic denial", firstDue: "2026-11-01", repeat: completion })).rejects.toThrow("RECURRENCE_AUTHORITY_UNAVAILABLE");
    expect((await f.db.prepare("SELECT COUNT(*) n FROM resource_records WHERE space_id=?").bind(f.spaceId).first<any>()).n).toBe(0);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM recurrence_plans WHERE space_id=?").bind(f.spaceId).first<any>()).n).toBe(0);
    expect((await f.db.prepare("SELECT COUNT(*) n FROM semantic_relations WHERE space_id=?").bind(f.spaceId).first<any>()).n).toBe(0);
  });
  it("measures real User JWT, Service Token and represented Agent Token 20-plan paths", async () => {
    const f = await fixture(), pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const pem = (label: string, bytes: ArrayBuffer) => `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----`;
    const privateKey = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
    const now = Math.floor(Date.now() / 1000);
    const jwt = await sign({ iss: "lifespace-identity", aud: "lifespace-core", sub: f.principal.id, azp: f.principal.clientId, principal_type: "user", scope: "resources:read resources:write", iat: now, exp: now + 900, jti: crypto.randomUUID() }, privateKey, "RS256");
    const service: Principal = { ...f.principal, type: "service", id: `svc_${crypto.randomUUID().replaceAll("-", "")}` };
    const agent: Principal = { ...f.principal, type: "agent", id: `agt_${crypto.randomUUID().replaceAll("-", "")}`, purpose: "agent_api" };
    await f.db.prepare("INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at) VALUES(?,?,'service',?,'space',NULL,'write',?,?)").bind(`grt_${crypto.randomUUID()}`, f.spaceId, service.id, f.principal.id, new Date().toISOString()).run();
    let authenticationCalls = 0, rootCalls = 0;
    const identity = { fetch: async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/recurrence-roots")) { rootCalls++; return Response.json({ data: { roots: JSON.parse(String(init.body)).roots.map((root: any) => ({ ...root, active: true, scopes: ["resources:read", "resources:write"] })) } }); }
      authenticationCalls++;
      return Response.json({ data: { active: true, audience: "lifespace-core", principal: String(url).endsWith("/agent-credentials") ? agent : service } });
    } };
    const b = { ...f.bindings, IDENTITY: identity, IDENTITY_PUBLIC_KEY: publicKey } as unknown as Bindings;
    const app = createApp();
    const issued = await app.request(`http://test/api/v1/spaces/${f.spaceId}/delegations`, { method: "POST", headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" }, body: JSON.stringify({ actor: { type: "agent", id: agent.id }, scope: { target: { type: "space", id: f.spaceId }, maxAccess: "write" } }) }, b);
    expect(issued.status).toBe(201);
    const delegationId = (await issued.json<any>()).data.id;
    for (const profile of [{ token: jwt, extra: {}, budget: 8, introspections: 0 }, { token: "lsp_svc_test", extra: {}, budget: 8, introspections: 1 }, { token: "lsp_agt_test", extra: { "x-lifespace-delegation-id": delegationId }, budget: 9, introspections: 1 }]) {
      const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] }, bindings = { ...b, DB: countingDatabase(f.db, cost) };
      await getRuntimeModel(bindings, f.modelKey); cost.roundTrips = 0; cost.rowsRead = 0; cost.sql = []; authenticationCalls = 0; rootCalls = 0;
      const response = await app.request(`http://test/api/v1/spaces/${f.spaceId}/models/batch`, { method: "POST", headers: { authorization: `Bearer ${profile.token}`, "content-type": "application/json", ...profile.extra }, body: JSON.stringify({ operations: Array.from({ length: 20 }, (_, i) => ({ operation: "create", modelKey: f.modelKey, data: { title: `Authenticated ${i}`, firstDue: "2026-11-01", repeat: completion } })) }) }, bindings);
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect(cost.roundTrips).toBeLessThanOrEqual(profile.budget);
      expect(authenticationCalls).toBe(profile.introspections); expect(rootCalls).toBe(1);
    }
  });
});

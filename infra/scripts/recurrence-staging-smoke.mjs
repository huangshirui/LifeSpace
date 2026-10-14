import assert from "node:assert/strict";

export async function runRecurrenceSmoke({ request, allowModel, waitForModelVisibility = async () => {}, tasksForPlan, cleanupAccess, marker, spaceId }) {
  const key = `smoke_repeat_${marker}`, path = `/api/v1/spaces/${spaceId}/models/${key}/records`;
  let published = false, plan;
  const taskVersions = new Map();
  async function call(url, method = "GET", body, role = "user", status = 200) {
    const result = await request(url, { method, body, role });
    assert.equal(result.status, status, `${method} ${url} Recurrence staging check failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`);
    return result.payload?.data;
  }
  let failure;
  try {
    await call("/api/v1/model-admin/models", "POST", { compatibility: "initial", definition: {
      definitionVersion: 1, key, display: { singular: "Synthetic recurrence", plural: "Synthetic recurrences" }, access: ["read", "write"],
      fields: { name: { type: "string", required: true }, firstDue: { type: "date", nullable: true }, repeat: { type: "recurrence_rule", nullable: true }, status: { type: "enum", values: ["active", "paused", "ended"], required: true } },
      defaults: { status: "active" }, capabilities: { recurrence: { ruleField: "repeat", firstDueDateField: "firstDue", statusField: "status", task: { nameField: "name" } } },
    } }, "admin", 201);
    published = true;
    await allowModel(key);
    await waitForModelVisibility(key);
    const detail = await call(`/api/v1/spaces/${spaceId}/_discovery/models/${key}`);
    assert.equal(detail.capabilityBindings.recurrence.ruleField, "repeat");
    plan = await call(path, "POST", { name: `Synthetic recurrence ${marker}`, firstDue: new Date().toISOString().slice(0, 10), repeat: { mode: "after_completion", interval: { value: 1, unit: "day" } } }, "user", 201);
    let tasks = await tasksForPlan(plan.id);
    assert.equal(tasks.length, 1, "Recurrence enrollment must atomically create one Task");
    taskVersions.set(tasks[0].id, tasks[0].version);
    const taskPath = id => `/api/v1/spaces/${spaceId}/models/task/records/${id}`;
    const first = await call(taskPath(tasks[0].id));
    assert.equal(first.name, `Synthetic recurrence ${marker}`);
    const completed = await call(`${taskPath(first.id)}/actions/complete`, "POST", { version: first.version });
    taskVersions.set(first.id, completed.version);
    tasks = await tasksForPlan(plan.id);
    for (const task of tasks) taskVersions.set(task.id, task.version);
    assert.equal(tasks.length, 2, "Real Identity root projection and successor generation must succeed together");
    assert.equal(completed.status, "completed");
    plan = await call(`${path}/${plan.id}`, "PATCH", { version: plan.version, status: "paused" });
    assert.equal(plan.status, "paused");
  } catch (error) { failure = error; }
  const cleanupFailures = [];
  async function clean(label, action) { try { await action(); } catch { cleanupFailures.push(label); } }
  if (plan) {
    await clean("remove recurrence rule", async () => { plan = await call(`${path}/${plan.id}`, "PATCH", { version: plan.version, repeat: null }); });
    await clean("read generated Task cleanup metadata", async () => { for (const task of await tasksForPlan(plan.id)) taskVersions.set(task.id, task.version); });
    for (const [id, version] of taskVersions) await clean("delete synthetic generated Task", () => call(`/api/v1/spaces/${spaceId}/models/task/records/${id}`, "DELETE", { version }, "user", 204));
    await clean("delete synthetic Plan", () => call(`${path}/${plan.id}`, "DELETE", { version: plan.version }, "user", 204));
  }
  if (published) await clean("retire recurrence smoke definition", () => call(`/api/v1/model-admin/models/${key}/retire`, "POST", {}, "admin", 204));
  await clean("remove temporary application model access", () => cleanupAccess(key));
  if (cleanupFailures.length) throw new Error(`Recurrence staging cleanup failed: ${cleanupFailures.join(", ")}`);
  if (failure) throw failure;
  return { ok: true, recurrenceEnrollment: true, identityRootProjection: true, completionSuccessor: true, pause: true, cleanup: true };
}

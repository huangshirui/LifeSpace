import test from "node:test";
import assert from "node:assert/strict";
import { runRecurrenceSmoke } from "./recurrence-staging-smoke.mjs";

function fixture(failCompletion = false) {
  let completed = false, version = 1, stopped = false, accessRemoved = false;
  const deleted = [], calls = [];
  return { deleted, calls, stopped: () => stopped, accessRemoved: () => accessRemoved,
    args: { marker: "synthetic", spaceId: "spc_synthetic", allowModel: async () => {}, cleanupAccess: async () => { accessRemoved = true; }, tasksForPlan: async () => [{ id: "rec_task_first", version: completed ? 2 : 1 }, ...(completed ? [{ id: "rec_task_next", version: 1 }] : [])],
      async request(path, { method, body }) {
        calls.push({ path, method, body });
        const reply = (status, data, code) => ({ status, payload: { data, error: { code } } });
        if (path.endsWith("/model-admin/models")) return reply(201, {});
        if (path.includes("/_discovery/")) return reply(200, { capabilityBindings: { recurrence: { ruleField: "repeat" } } });
        if (path.endsWith("/retire") || method === "DELETE") { deleted.push(path); return reply(204); }
        if (path.endsWith("/actions/complete")) { if (failCompletion) return reply(503, null, "IDENTITY_UNAVAILABLE"); completed = true; return reply(200, { id: "rec_task_first", version: 2, status: "completed" }); }
        if (path.includes("/models/task/")) return reply(200, { id: "rec_task_first", name: "Synthetic recurrence synthetic", version: 1 });
        if (method === "PATCH") { version++; if (body.repeat === null) stopped = true; return reply(200, { id: "rec_plan", version, status: "paused" }); }
        return reply(201, { id: "rec_plan", version });
      },
    },
  };
}
test("staging Recurrence verifies enrollment/completion and clears rule before deleting Tasks", async () => {
  const f = fixture(); const result = await runRecurrenceSmoke(f.args);
  assert.equal(result.identityRootProjection, true); assert.equal(f.stopped(), true); assert.equal(f.accessRemoved(), true);
  assert.equal(f.deleted.filter(path => path.includes("/models/task/")).length, 2);
  assert.ok(f.calls.findIndex(c => c.body?.repeat === null) < f.calls.findIndex(c => c.method === "DELETE"));
});
test("unavailable live Identity projection fails acceptance and cleans the enrolled synthetic Plan", async () => {
  const f = fixture(true); await assert.rejects(runRecurrenceSmoke(f.args), /IDENTITY_UNAVAILABLE/);
  assert.equal(f.stopped(), true); assert.equal(f.accessRemoved(), true);
  assert.equal(f.calls.filter(c => c.path.endsWith("/actions/complete")).length, 1);
});

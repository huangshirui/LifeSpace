import test from "node:test";
import assert from "node:assert/strict";
import { runExternalProviderSmoke } from "./external-provider-smoke.mjs";

function fixture({ failCreate = false, failCleanup = false } = {}) {
  const calls = [], retired = [], trashed = [], nativeDeleted = [];
  let disabled = false, deleted = false, amount = 17, removed = false;
  const externalKey = "smoke_ext_synthetic", nativeKey = "smoke_link_synthetic";
  const params = {
    marker: "synthetic", spaceId: "spc_synthetic", resourceId: "10000000000000000000000000000001", credentialRef: "synthetic_ref",
    allowModels: async keys => assert.deepEqual(keys, [externalKey, nativeKey]),
    verifyScheduledRefresh: async registration => assert.equal(registration, "ext_synthetic"),
    cleanupMetadata: async ({ source }) => { assert.equal(source, "exs_synthetic"); if (failCleanup) throw new Error("sensitive synthetic detail"); removed = true; },
    async request(path, { method, body, role }) {
      calls.push({ path, method, body, role });
      const response = (status, data, code) => ({ status, payload: { data, error: code ? { code } : undefined } });
      if (path.endsWith("/external-sources") && role === "admin") return response(201, { id: "exs_synthetic" });
      if (path.endsWith("/model-admin/models")) return response(201, {});
      if (path.endsWith("/retire")) { retired.push(path); return response(204); }
      if (path.includes("external-sources/exs_")) { disabled = body.status === "disabled"; return response(200, {}); }
      if (path.endsWith("/external-models")) return response(201, { registrationId: "ext_synthetic", origin: "external", schemaHash: "synthetic_hash", fields: [{ key: "f_title", title: "Name", type: "string", writable: true }, { key: "f_amount", title: "Amount", type: "number", writable: true, operators: ["eq"] }] });
      if (path.includes("/_discovery/")) return response(200, { origin: "external", schemaHash: "synthetic_hash" });
      if (path.endsWith("/refresh")) return response(200, {});
      if (path.endsWith("/models/batch")) return body.atomicConsistency === false ? response(200, { items: [{ status: "failed" }, { status: "succeeded", relationId: "rel_synthetic" }, { status: "succeeded", recordId: "rec_native_batch", version: 1 }] }) : response(422, null, "EXTERNAL_ATOMIC_UNSUPPORTED");
      if (path.endsWith("/semantic-relations")) return response(200, { id: "rel_synthetic" });
      if (path.includes("semantic-relations/")) return deleted ? response(404) : response(method === "DELETE" ? 204 : 200, { targetRecord: { id: "rec_external_synthetic", origin: "external" } });
      if (path.includes(nativeKey)) {
        if (method === "DELETE") { nativeDeleted.push(path); return response(204); }
        return response(201, { id: "rec_native_synthetic", version: 1 });
      }
      if (disabled) return response(404);
      if (method === "POST" && !path.endsWith("/query")) return failCreate ? response(502, null, "EXTERNAL_WRITE_UNKNOWN") : response(201, { id: "rec_external_synthetic", origin: "external", f_amount: amount });
      if (method === "DELETE") { deleted = true; trashed.push(path); return response(204); }
      if (method === "PATCH") amount = body.f_amount;
      const record = { id: "rec_external_synthetic", origin: "external", f_amount: amount };
      return response(200, path.endsWith("/query") ? { items: [record] } : record);
    },
  };
  return { params, calls, retired, trashed, nativeDeleted, removed: () => removed };
}
test("live smoke orchestration follows closed contracts and cleans run-scoped synthetic data", async () => {
  const f = fixture(); const result = await runExternalProviderSmoke(f.params);
  assert.equal(result.ok, true); assert.equal(result.sourceRevocation, true);
  assert.equal(f.trashed.length, 1); assert.equal(f.nativeDeleted.length, 2); assert.equal(f.retired.length, 2); assert.equal(f.removed(), true);
  const batch = f.calls.find(c => c.body?.atomicConsistency === false);
  assert.equal(batch.body.operations[0].operation, "create");
  assert.ok(batch.body.operations.every(op => op.operation !== "update"));
});
test("unknown Provider create aborts without retry and still retires/unbinds synthetic metadata", async () => {
  const f = fixture({ failCreate: true });
  await assert.rejects(runExternalProviderSmoke(f.params), /EXTERNAL_WRITE_UNKNOWN/);
  assert.equal(f.calls.filter(c => c.method === "POST" && c.path.includes("smoke_ext_synthetic/records")).length, 1);
  assert.equal(f.trashed.length, 0); assert.equal(f.retired.length, 2); assert.equal(f.removed(), true);
});
test("cleanup failure makes acceptance fail and suppresses secret/provider error details", async () => {
  const f = fixture({ failCleanup: true });
  await assert.rejects(runExternalProviderSmoke(f.params), error => error.message.includes("cleanup failed") && !error.message.includes("sensitive synthetic detail"));
});

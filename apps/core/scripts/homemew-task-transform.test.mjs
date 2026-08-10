import assert from "node:assert/strict";
import test from "node:test";
import { transformTaskSnapshot } from "./homemew-task-transform.mjs";

const exportedAt = "2026-08-10T00:00:00.000Z";

function manifest() {
  return {
    version: 1,
    source: { schemaVersion: "11", exportedAt },
    users: [
      { legacyUserId: "usr_owner", lifespaceUserId: "usr_owner" },
      { legacyUserId: "usr_member", lifespaceUserId: "usr_member" },
    ],
    families: [{ legacyFamilyId: "fam_home", spaceId: "spc_00000000000000000000000000000001" }],
    memberships: [
      { legacyMembershipId: "fmem_owner", membershipId: "mem_owner", personId: "per_owner" },
      { legacyMembershipId: "fmem_member", membershipId: "mem_member", personId: "per_member" },
    ],
  };
}

function snapshot() {
  return {
    source: { schemaVersion: "11", exportedAt, commit: "homemew-main" },
    users: [
      { id: "usr_owner", displayName: "Owner" },
      { id: "usr_member", displayName: "Member" },
    ],
    systemIdentities: [{ id: "sys_n8n", name: "n8n" }],
    familyMembers: [
      { id: "fmem_owner", familyId: "fam_home", userId: "usr_owner", status: "active" },
      { id: "fmem_member", familyId: "fam_home", userId: "usr_member", status: "active" },
    ],
    tasks: [
      {
        id: "tsk_pending", familyId: "fam_home", name: "Buy milk", description: "Two cartons", dueDate: "2026-08-12", status: "pending",
        completedAt: null, completedByType: null, completedById: null,
        createdByType: "system", createdById: "sys_n8n", updatedByType: "user", updatedById: "usr_owner",
        version: 2, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
      {
        id: "tsk_done", familyId: "fam_home", name: "Homework", description: null, dueDate: null, status: "completed",
        completedAt: "2026-08-03T01:02:03.000Z", completedByType: "user", completedById: "usr_member",
        createdByType: "user", createdById: "usr_owner", updatedByType: "user", updatedById: "usr_member",
        version: 4, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-03T01:02:03.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
    ],
    taskAssignees: [
      { taskId: "tsk_pending", userId: "usr_member", createdAt: "2026-08-01T00:00:00.000Z" },
      { taskId: "tsk_done", userId: "usr_member", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  };
}

test("task transformation is deterministic and preserves IDs, lifecycle actors, due dates and assignee people", () => {
  const first = transformTaskSnapshot(snapshot(), manifest());
  const second = transformTaskSnapshot(snapshot(), manifest());
  assert.deepEqual(first, second);
  assert.match(first.coreSql, /'tsk_pending'/);
  assert.match(first.coreSql, /'per_member'/);
  assert.match(first.coreSql, /'service','sys_n8n','n8n'/);
  assert.equal(first.report.taskStatuses.pending, 1);
  assert.equal(first.report.taskStatuses.completed, 1);
  assert.deepEqual(first.report.preservedSystemActorIds, ["sys_n8n"]);
});

test("task transformation rejects assignees without membership in the task family", () => {
  const input = snapshot();
  input.familyMembers = input.familyMembers.filter((member) => member.userId !== "usr_member");
  assert.throws(() => transformTaskSnapshot(input, manifest()), /has no family membership/);
});

test("task transformation enforces completion invariants", () => {
  const input = snapshot();
  input.tasks[0].status = "completed";
  assert.throws(() => transformTaskSnapshot(input, manifest()), /must have completion actor and timestamp/);
});

test("task transformation requires the same source export as the family mapping", () => {
  const mapping = manifest();
  mapping.source.exportedAt = "2026-08-09T00:00:00.000Z";
  assert.throws(() => transformTaskSnapshot(snapshot(), mapping), /exportedAt must match/);
});

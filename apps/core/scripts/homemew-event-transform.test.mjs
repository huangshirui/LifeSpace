import assert from "node:assert/strict";
import test from "node:test";
import { transformEventSnapshot } from "./homemew-event-transform.mjs";

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
    events: [
      {
        id: "evt_timed", familyId: "fam_home", summary: "Training", description: null, location: "Pitch",
        isAllDay: false, startAt: "2026-08-10T10:00:00.000Z", endAt: "2026-08-10T12:00:00.000Z",
        startTimezone: "Asia/Shanghai", endTimezone: "Asia/Shanghai", status: "active",
        createdByType: "system", createdById: "sys_n8n", updatedByType: "user", updatedById: "usr_owner",
        version: 3, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-02T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
      {
        id: "evt_allday", familyId: "fam_home", summary: "Holiday", description: "Two days", location: null,
        isAllDay: true, startDate: "2026-08-11", endDateExclusive: "2026-08-13",
        startTimezone: null, endTimezone: null, status: "active",
        createdByType: "user", createdById: "usr_owner", updatedByType: "user", updatedById: "usr_owner",
        version: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
    ],
    eventAttendees: [
      { eventId: "evt_timed", userId: "usr_member", createdAt: "2026-08-01T00:00:00.000Z" },
    ],
  };
}

test("event transformation is deterministic and preserves event IDs, actors, time semantics and attendee people", () => {
  const first = transformEventSnapshot(snapshot(), manifest());
  const second = transformEventSnapshot(snapshot(), manifest());
  assert.deepEqual(first, second);
  assert.match(first.coreSql, /'evt_timed'/);
  assert.match(first.coreSql, /'per_member'/);
  assert.match(first.coreSql, /'service','sys_n8n','n8n'/);
  assert.equal(first.report.eventKinds.timed, 1);
  assert.equal(first.report.eventKinds.allDay, 1);
  assert.deepEqual(first.report.preservedSystemActorIds, ["sys_n8n"]);
});

test("event transformation rejects cross-family or missing attendee membership", () => {
  const input = snapshot();
  input.familyMembers = input.familyMembers.filter((member) => member.userId !== "usr_member");
  assert.throws(() => transformEventSnapshot(input, manifest()), /has no family membership/);
});

test("event transformation requires the same source export as the family mapping", () => {
  const mapping = manifest();
  mapping.source.exportedAt = "2026-08-09T00:00:00.000Z";
  assert.throws(() => transformEventSnapshot(snapshot(), mapping), /exportedAt must match/);
});

test("event transformation rejects normalized but impossible all-day dates", () => {
  const input = snapshot();
  input.events[1].startDate = "2026-02-31";
  assert.throws(() => transformEventSnapshot(input, manifest()), /must be a valid date/);
});

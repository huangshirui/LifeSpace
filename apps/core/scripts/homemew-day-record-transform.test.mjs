import assert from "node:assert/strict";
import test from "node:test";
import { transformDayRecordSnapshot } from "./homemew-day-record-transform.mjs";

const exportedAt = "2026-08-10T00:00:00.000Z";
const familyManifest = {
  source: { schemaVersion: "11", exportedAt },
  users: [
    { legacyUserId: "usr_owner", lifespaceUserId: "usr_owner" },
    { legacyUserId: "usr_removed", lifespaceUserId: "usr_removed" },
  ],
  families: [{ legacyFamilyId: "fam_home", spaceId: "spc_home" }],
  memberships: [
    { legacyMembershipId: "fmem_owner", personId: "per_owner" },
    { legacyMembershipId: "fmem_removed", personId: "per_removed" },
  ],
};

function snapshot() {
  return {
    source: { schemaVersion: 11, exportedAt, commit: "abc123" },
    users: [
      { id: "usr_owner", displayName: "Owner" },
      { id: "usr_removed", displayName: "Former member" },
    ],
    systemIdentities: [{ id: "sys_home", name: "HomeMew system" }],
    familyMembers: [
      { id: "fmem_owner", familyId: "fam_home", userId: "usr_owner", status: "active" },
      { id: "fmem_removed", familyId: "fam_home", userId: "usr_removed", status: "removed" },
    ],
    dayRecords: [
      {
        id: "day_elapsed", familyId: "fam_home", name: "Haircut", description: null, kind: "elapsed",
        anchorDate: "2026-08-10", cycleDays: null, nextDueDate: null, attentionBeforeDays: null, attentionAfterDays: 30,
        subjectUserId: "usr_removed", icon: "✂️", status: "active",
        createdByType: "user", createdById: "usr_owner", updatedByType: "system", updatedById: "sys_home",
        version: 2, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
      {
        id: "day_countdown", familyId: "fam_home", name: "Trip", description: null, kind: "countdown",
        anchorDate: "2026-09-01", cycleDays: null, nextDueDate: null, attentionBeforeDays: 30, attentionAfterDays: null,
        subjectUserId: null, icon: null, status: "archived",
        createdByType: "user", createdById: "usr_owner", updatedByType: "user", updatedById: "usr_owner",
        version: 3, createdAt: "2026-08-02T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
      {
        id: "day_cycle", familyId: "fam_home", name: "Filter", description: "HVAC", kind: "cycle",
        anchorDate: "2026-08-10", cycleDays: 30, nextDueDate: "2026-09-09", attentionBeforeDays: 7, attentionAfterDays: null,
        subjectUserId: "usr_owner", icon: null, status: "active",
        createdByType: "system", createdById: "sys_home", updatedByType: "user", updatedById: "usr_owner",
        version: 4, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
    ],
    dayRecordOccurrences: [
      {
        id: "dyo_elapsedinitial", dayRecordId: "day_elapsed", occurredOn: "2026-07-01", note: null, source: "initial",
        recordedByType: "user", recordedById: "usr_owner", createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "dyo_elapsedmanual", dayRecordId: "day_elapsed", occurredOn: "2026-08-10", note: "Done", source: "manual",
        recordedByType: "system", recordedById: "sys_home", createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "dyo_cycleinitial", dayRecordId: "day_cycle", occurredOn: "2026-07-11", note: null, source: "initial",
        recordedByType: "system", recordedById: "sys_home", createdAt: "2026-07-11T00:00:00.000Z",
      },
      {
        id: "dyo_cyclemanual", dayRecordId: "day_cycle", occurredOn: "2026-08-10", note: null, source: "manual",
        recordedByType: "user", recordedById: "usr_owner", createdAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
}

test("transforms Day records deterministically with Space Person subjects and actor conversion", () => {
  const first = transformDayRecordSnapshot(snapshot(), familyManifest);
  const second = transformDayRecordSnapshot(snapshot(), familyManifest);
  assert.equal(first.coreSql, second.coreSql);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.report.sourceCounts.dayRecords, 3);
  assert.equal(first.report.targetCounts.dayRecordOccurrences, 4);
  assert.deepEqual(first.report.kinds, { elapsed: 1, countdown: 1, cycle: 1 });
  assert.deepEqual(first.report.historicalSubjectsFromRemovedMemberships, [
    { dayRecordId: "day_elapsed", legacyUserId: "usr_removed", personId: "per_removed" },
  ]);
  assert.deepEqual(first.report.preservedSystemActorIds, ["sys_home"]);
  assert.match(first.coreSql, /'day_elapsed','spc_home'/);
  assert.match(first.coreSql, /'per_removed'/);
  assert.match(first.coreSql, /'service','sys_home','HomeMew system'/);
  assert.match(first.coreSql, /'dyo_cyclemanual','day_cycle','2026-08-10'/);
});

test("rejects a transform built from a different family export", () => {
  assert.throws(() => transformDayRecordSnapshot(snapshot(), {
    ...familyManifest,
    source: { schemaVersion: "11", exportedAt: "2026-08-11T00:00:00.000Z" },
  }), /exportedAt must match/);
});

test("rejects inconsistent cycle nextDueDate", () => {
  const value = snapshot();
  value.dayRecords.find((record) => record.id === "day_cycle").nextDueDate = "2026-09-10";
  assert.throws(() => transformDayRecordSnapshot(value, familyManifest), /nextDueDate is inconsistent/);
});

test("rejects occurrence history whose latest date is not the current anchor", () => {
  const value = snapshot();
  value.dayRecordOccurrences.find((occurrence) => occurrence.id === "dyo_elapsedmanual").occurredOn = "2026-08-09";
  assert.throws(() => transformDayRecordSnapshot(value, familyManifest), /anchorDate must equal its latest occurrence date/);
});

test("rejects countdown occurrence history", () => {
  const value = snapshot();
  value.dayRecordOccurrences.push({
    id: "dyo_countdown", dayRecordId: "day_countdown", occurredOn: "2026-08-01", note: null, source: "manual",
    recordedByType: "user", recordedById: "usr_owner", createdAt: "2026-08-01T00:00:00.000Z",
  });
  assert.throws(() => transformDayRecordSnapshot(value, familyManifest), /countdown day record day_countdown cannot have occurrences/);
});

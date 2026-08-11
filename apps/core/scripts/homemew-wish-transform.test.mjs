import assert from "node:assert/strict";
import test from "node:test";
import { transformWishSnapshot } from "./homemew-wish-transform.mjs";

const exportedAt = "2026-08-11T00:00:00.000Z";
const familyManifest = {
  source: { schemaVersion: "11", exportedAt },
  users: [
    { legacyUserId: "usr_owner", lifespaceUserId: "usr_owner" },
    { legacyUserId: "usr_member", lifespaceUserId: "usr_member" },
    { legacyUserId: "usr_removed", lifespaceUserId: "usr_removed" },
  ],
  families: [{ legacyFamilyId: "fam_home", spaceId: "spc_home" }],
  memberships: [
    { legacyMembershipId: "fmem_owner", personId: "per_owner" },
    { legacyMembershipId: "fmem_member", personId: "per_member" },
    { legacyMembershipId: "fmem_removed", personId: "per_removed" },
  ],
};

function snapshot() {
  return {
    source: { schemaVersion: 11, exportedAt, commit: "wish123" },
    users: [
      { id: "usr_owner", displayName: "Owner" },
      { id: "usr_member", displayName: "Member" },
      { id: "usr_removed", displayName: "Former member" },
    ],
    familyMembers: [
      { id: "fmem_owner", familyId: "fam_home", userId: "usr_owner", status: "active" },
      { id: "fmem_member", familyId: "fam_home", userId: "usr_member", status: "active" },
      { id: "fmem_removed", familyId: "fam_home", userId: "usr_removed", status: "removed" },
    ],
    wishes: [
      {
        id: "wsh_open", familyId: "fam_home", ownerUserId: "usr_owner", title: "Open", description: null,
        desiredDate: "2026-12-01", status: "open", claimantUserId: null, claimedAt: null,
        fulfilledByUserId: null, fulfilledAt: null, archivedFromStatus: null,
        createdByType: "user", createdById: "usr_owner", updatedByType: "user", updatedById: "usr_owner",
        version: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
      {
        id: "wsh_fulfilled", familyId: "fam_home", ownerUserId: "usr_owner", title: "Fulfilled", description: "Done",
        desiredDate: null, status: "fulfilled", claimantUserId: "usr_member", claimedAt: "2026-08-02T00:00:00.000Z",
        fulfilledByUserId: "usr_owner", fulfilledAt: "2026-08-03T00:00:00.000Z", archivedFromStatus: null,
        createdByType: "user", createdById: "usr_owner", updatedByType: "user", updatedById: "usr_owner",
        version: 4, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-03T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
      {
        id: "wsh_archived", familyId: "fam_home", ownerUserId: "usr_owner", title: "Archived claim", description: null,
        desiredDate: null, status: "archived", claimantUserId: "usr_removed", claimedAt: "2026-08-04T00:00:00.000Z",
        fulfilledByUserId: null, fulfilledAt: null, archivedFromStatus: "claimed",
        createdByType: "user", createdById: "usr_owner", updatedByType: "user", updatedById: "usr_owner",
        version: 3, createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
        deletedAt: null, deletedByType: null, deletedById: null,
      },
    ],
  };
}

test("transforms wishes deterministically with Space Person lifecycle references", () => {
  const first = transformWishSnapshot(snapshot(), familyManifest);
  const second = transformWishSnapshot(snapshot(), familyManifest);
  assert.equal(first.coreSql, second.coreSql);
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.report.sourceCounts.wishes, 3);
  assert.deepEqual(first.report.statuses, { open: 1, claimed: 0, fulfilled: 1, archived: 1 });
  assert.deepEqual(first.report.historicalPeopleFromRemovedMemberships, [
    { wishId: "wsh_archived", role: "claimant", legacyUserId: "usr_removed", personId: "per_removed" },
  ]);
  assert.deepEqual(first.report.archivedClaimedWithRemovedClaimant, [
    { wishId: "wsh_archived", legacyUserId: "usr_removed", personId: "per_removed" },
  ]);
  assert.match(first.coreSql, /'wsh_open','spc_home','per_owner'/);
  assert.match(first.coreSql, /'wsh_fulfilled'.*'per_member'.*'per_owner'/s);
  assert.match(first.coreSql, /'wsh_archived'.*'per_removed'.*'claimed'/s);
});

test("rejects a wish transform built from a different family export", () => {
  assert.throws(() => transformWishSnapshot(snapshot(), {
    ...familyManifest,
    source: { schemaVersion: "11", exportedAt: "2026-08-12T00:00:00.000Z" },
  }), /exportedAt must match/);
});

test("rejects lifecycle fields that contradict status", () => {
  const value = snapshot();
  value.wishes.find((wish) => wish.id === "wsh_open").claimantUserId = "usr_member";
  value.wishes.find((wish) => wish.id === "wsh_open").claimedAt = "2026-08-02T00:00:00.000Z";
  assert.throws(() => transformWishSnapshot(value, familyManifest), /open wish wsh_open has incompatible lifecycle fields/);
});

test("preserves removed claimant history instead of rewriting archived state during migration", () => {
  const result = transformWishSnapshot(snapshot(), familyManifest);
  assert.match(result.coreSql, /'wsh_archived'.*'archived','per_removed'/s);
  assert.equal(result.report.archivedClaimedWithRemovedClaimant.length, 1);
});

test("rejects owner references without a family membership", () => {
  const value = snapshot();
  value.wishes[0].ownerUserId = "usr_removed";
  value.familyMembers = value.familyMembers.filter((member) => member.userId !== "usr_removed");
  assert.throws(() => transformWishSnapshot(value, familyManifest), /ownerUserId has no family membership/);
});

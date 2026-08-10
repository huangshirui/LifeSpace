import assert from "node:assert/strict";
import test from "node:test";
import { transformSnapshot } from "./homemew-family-transform.mjs";

function snapshot() {
  return {
    source: { schemaVersion: "11", exportedAt: "2026-08-10T00:00:00.000Z", commit: "6ecdc7f3" },
    users: [
      { id: "usr_owner", displayName: "Owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "usr_member", displayName: "Member", status: "active", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ],
    families: [
      { id: "fam_home", name: "Home", timezone: "Asia/Shanghai", createdBy: "usr_owner", status: "active", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
    ],
    familyMembers: [
      { id: "fmem_owner", familyId: "fam_home", userId: "usr_owner", role: "admin", status: "active", joinedAt: "2026-02-01T00:00:00.000Z", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
      { id: "fmem_member", familyId: "fam_home", userId: "usr_member", role: "member", status: "active", joinedAt: "2026-02-02T00:00:00.000Z", createdAt: "2026-02-02T00:00:00.000Z", updatedAt: "2026-02-02T00:00:00.000Z" },
    ],
    familyInvites: [
      { id: "inv_home", familyId: "fam_home", codeHash: "a".repeat(64), codePrefix: "HM-ABCD", status: "active", expiresAt: "2027-01-01T00:00:00.000Z", maxUses: 8, usedCount: 1, createdBy: "usr_owner", createdAt: "2026-02-03T00:00:00.000Z", updatedAt: "2026-02-04T00:00:00.000Z" },
    ],
    inviteRedemptions: [
      { id: "ired_one", inviteId: "inv_home", familyId: "fam_home", userId: "usr_member", redeemedAt: "2026-02-04T00:00:00.000Z" },
    ],
  };
}

test("family transformation is deterministic and emits explicit maps", () => {
  const first = transformSnapshot(snapshot());
  const second = transformSnapshot(snapshot());
  assert.deepEqual(first, second);
  assert.equal(first.manifest.families[0].legacyFamilyId, "fam_home");
  assert.match(first.manifest.families[0].spaceId, /^spc_[a-f0-9]{32}$/);
  assert.match(first.coreSql, /legacy_homemew_family_maps/);
  assert.match(first.coreSql, /'owner'/);
  assert.match(first.coreSql, /'editor'/);
  assert.equal(first.report.status, "ready");
});

test("family transformation rejects broken authorization invariants", () => {
  const input = snapshot();
  input.familyMembers[0].role = "member";
  assert.throws(() => transformSnapshot(input), /no active administrator/);
});

test("duplicate historic invite redemption pairs are explicit in the report", () => {
  const input = snapshot();
  input.inviteRedemptions.push({ ...input.inviteRedemptions[0], id: "ired_two" });
  input.familyInvites[0].usedCount = 2;
  const result = transformSnapshot(input);
  assert.deepEqual(result.report.collapsedHistoricalInviteRedemptions, ["ired_two"]);
  assert.equal(result.report.targetCounts.inviteRedemptions, 1);
  assert.match(result.coreSql, /SET used_count=2/);
});

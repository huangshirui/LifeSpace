import assert from "node:assert/strict";
import test from "node:test";
import { transformSnapshot } from "./homemew-family-transform.mjs";

function snapshot() {
  return {
    source: { schemaVersion: "11", exportedAt: "2026-08-10T00:00:00.000Z", commit: "6ecdc7f3" },
    users: [
      { id: "usr_owner", displayName: "Owner", avatarKey: "avatars/usr_owner/owner.png", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "usr_member", displayName: "Member", avatarKey: null, status: "active", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" },
    ],
    families: [
      { id: "fam_home", name: "Home", avatarKey: "avatars/families/fam_home/home.webp", timezone: "Asia/Shanghai", createdBy: "usr_owner", status: "active", createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
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

test("family transformation is deterministic and emits explicit maps and avatar copy manifest", () => {
  const first = transformSnapshot(snapshot());
  const second = transformSnapshot(snapshot());
  assert.deepEqual(first, second);
  assert.equal(first.manifest.version, 2);
  assert.equal(first.manifest.families[0].legacyFamilyId, "fam_home");
  assert.match(first.manifest.families[0].spaceId, /^spc_[a-f0-9]{32}$/);
  assert.match(first.coreSql, /legacy_homemew_family_maps/);
  assert.match(first.coreSql, /'owner'/);
  assert.match(first.coreSql, /'editor'/);
  assert.match(first.identitySql, /avatar_key/);
  assert.match(first.identitySql, /avatars\/users\/usr_owner\/owner\.png/);
  assert.match(first.coreSql, /avatar_key/);
  assert.match(first.coreSql, /avatars\/spaces\/spc_[a-f0-9]{32}\/home\.webp/);
  assert.equal(first.objectManifest.length, 2);
  assert.deepEqual(first.objectManifest[0], {
    sourceKey: "avatars/usr_owner/owner.png",
    targetKey: "avatars/users/usr_owner/owner.png",
    ownerType: "user",
    legacyOwnerId: "usr_owner",
    targetOwnerId: "usr_owner",
  });
  assert.equal(first.objectManifest[1].sourceKey, "avatars/families/fam_home/home.webp");
  assert.match(first.objectManifest[1].targetKey, /^avatars\/spaces\/spc_[a-f0-9]{32}\/home\.webp$/);
  assert.equal(first.report.objects.total, 2);
  assert.equal(first.report.objects.userAvatars, 1);
  assert.equal(first.report.objects.spaceAvatars, 1);
  assert.equal(first.report.status, "ready");
});

test("family transformation rejects broken authorization invariants", () => {
  const input = snapshot();
  input.familyMembers[0].role = "member";
  assert.throws(() => transformSnapshot(input), /no active administrator/);
});

test("family transformation rejects avatar keys outside the legacy owner namespace", () => {
  const input = snapshot();
  input.users[0].avatarKey = "avatars/usr_other/wrong.png";
  assert.throws(() => transformSnapshot(input), /avatarKey must start with avatars\/usr_owner\//);
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

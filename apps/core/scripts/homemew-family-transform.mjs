import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ID = /^(usr|fam|fmem|inv|ired)_[A-Za-z0-9]+$/;

function fail(message) {
  throw new Error(`HomeMew family snapshot is invalid: ${message}`);
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value;
}

function string(value, field) {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function instant(value, field) {
  const result = string(value, field);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(`${field} must be an RFC 3339 UTC instant`);
  return result;
}

function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function deterministicId(prefix, namespace, legacyId) {
  return `${prefix}_${createHash("sha256").update(`${namespace}\0${legacyId}`).digest("hex").slice(0, 32)}`;
}

function uniqueById(items, label) {
  const map = new Map();
  for (const item of items) {
    const id = string(item.id, `${label}.id`);
    if (!ID.test(id)) fail(`${label} contains unsupported id ${id}`);
    if (map.has(id)) fail(`${label} contains duplicate id ${id}`);
    map.set(id, item);
  }
  return map;
}

function assertTimezone(value, field) {
  const zone = string(value, field);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
  } catch {
    fail(`${field} must be an IANA timezone`);
  }
  return zone;
}

export function transformSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("root must be an object");
  const source = snapshot.source ?? {};
  if (String(source.schemaVersion) !== "11") fail("source.schemaVersion must be 11");
  const migratedAt = instant(source.exportedAt, "source.exportedAt");
  const users = array(snapshot.users, "users");
  const families = array(snapshot.families, "families");
  const members = array(snapshot.familyMembers, "familyMembers");
  const invites = array(snapshot.familyInvites ?? [], "familyInvites");
  const redemptions = array(snapshot.inviteRedemptions ?? [], "inviteRedemptions");
  const usersById = uniqueById(users, "users");
  const familiesById = uniqueById(families, "families");
  const membersById = uniqueById(members, "familyMembers");
  const invitesById = uniqueById(invites, "familyInvites");
  uniqueById(redemptions, "inviteRedemptions");

  const userMaps = new Map();
  for (const user of users) {
    if (!["active", "disabled"].includes(user.status)) fail(`user ${user.id} has invalid status`);
    string(user.displayName, `user ${user.id}.displayName`);
    instant(user.createdAt, `user ${user.id}.createdAt`);
    instant(user.updatedAt, `user ${user.id}.updatedAt`);
    userMaps.set(user.id, /^usr_[A-Za-z0-9]+$/.test(user.id) ? user.id : deterministicId("usr", "homemew-user", user.id));
  }

  const familyMaps = new Map();
  const membersByFamily = new Map();
  for (const member of members) {
    if (!familiesById.has(member.familyId)) fail(`membership ${member.id} references missing family ${member.familyId}`);
    if (!usersById.has(member.userId)) fail(`membership ${member.id} references missing user ${member.userId}`);
    if (!["admin", "member"].includes(member.role) || !["active", "removed"].includes(member.status)) {
      fail(`membership ${member.id} has invalid role or status`);
    }
    instant(member.joinedAt, `membership ${member.id}.joinedAt`);
    instant(member.createdAt, `membership ${member.id}.createdAt`);
    instant(member.updatedAt, `membership ${member.id}.updatedAt`);
    if (member.removedAt !== null && member.removedAt !== undefined) instant(member.removedAt, `membership ${member.id}.removedAt`);
    const key = `${member.familyId}\0${member.userId}`;
    if (membersById.get(member.id) !== member) fail(`membership ${member.id} is duplicated`);
    const list = membersByFamily.get(member.familyId) ?? [];
    if (list.some((existing) => `${existing.familyId}\0${existing.userId}` === key)) {
      fail(`family ${member.familyId} contains duplicate membership for ${member.userId}`);
    }
    list.push(member);
    membersByFamily.set(member.familyId, list);
  }

  const ownerByFamily = new Map();
  for (const family of families) {
    if (!usersById.has(family.createdBy)) fail(`family ${family.id} references missing creator ${family.createdBy}`);
    if (!["active", "archived"].includes(family.status)) fail(`family ${family.id} has invalid status`);
    string(family.name, `family ${family.id}.name`);
    assertTimezone(family.timezone, `family ${family.id}.timezone`);
    instant(family.createdAt, `family ${family.id}.createdAt`);
    instant(family.updatedAt, `family ${family.id}.updatedAt`);
    const active = (membersByFamily.get(family.id) ?? []).filter((member) => member.status === "active");
    const admins = active.filter((member) => member.role === "admin");
    if (family.status === "active" && (active.length < 1 || active.length > 8)) fail(`active family ${family.id} must have 1-8 active members`);
    if (family.status === "active" && admins.length < 1) fail(`active family ${family.id} has no active administrator`);
    const creator = admins.find((member) => member.userId === family.createdBy);
    ownerByFamily.set(family.id, creator ?? admins.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))[0] ?? null);
    familyMaps.set(family.id, deterministicId("spc", "homemew-family", family.id));
  }
  for (const user of users) {
    const activeCreated = families.filter((family) => family.createdBy === user.id && family.status === "active");
    if (activeCreated.length > 3) fail(`user ${user.id} created more than three active families`);
  }

  for (const invite of invites) {
    if (!familiesById.has(invite.familyId)) fail(`invite ${invite.id} references missing family ${invite.familyId}`);
    if (!usersById.has(invite.createdBy)) fail(`invite ${invite.id} references missing creator ${invite.createdBy}`);
    if (invite.revokedBy && !usersById.has(invite.revokedBy)) fail(`invite ${invite.id} references missing revoker ${invite.revokedBy}`);
    if (!["active", "expired", "exhausted", "revoked"].includes(invite.status)) fail(`invite ${invite.id} has invalid status`);
    if (typeof invite.codeHash !== "string" || !/^[a-f0-9]{64}$/i.test(invite.codeHash)) fail(`invite ${invite.id} has invalid codeHash`);
    if (!Number.isInteger(invite.maxUses) || invite.maxUses < 1 || invite.maxUses > 8) fail(`invite ${invite.id} has invalid maxUses`);
    if (!Number.isInteger(invite.usedCount) || invite.usedCount < 0 || invite.usedCount > invite.maxUses) fail(`invite ${invite.id} has invalid usedCount`);
    instant(invite.expiresAt, `invite ${invite.id}.expiresAt`);
    instant(invite.createdAt, `invite ${invite.id}.createdAt`);
    instant(invite.updatedAt, `invite ${invite.id}.updatedAt`);
  }

  const seenRedemptions = new Set();
  const migratedRedemptions = [];
  const collapsedRedemptions = [];
  for (const redemption of redemptions) {
    const invite = invitesById.get(redemption.inviteId);
    if (!invite) fail(`redemption ${redemption.id} references missing invite ${redemption.inviteId}`);
    if (!usersById.has(redemption.userId)) fail(`redemption ${redemption.id} references missing user ${redemption.userId}`);
    if (redemption.familyId !== invite.familyId) fail(`redemption ${redemption.id} family does not match its invite`);
    instant(redemption.redeemedAt, `redemption ${redemption.id}.redeemedAt`);
    const pair = `${redemption.inviteId}\0${redemption.userId}`;
    if (seenRedemptions.has(pair)) collapsedRedemptions.push(redemption.id);
    else {
      seenRedemptions.add(pair);
      migratedRedemptions.push(redemption);
    }
  }

  const identity = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const user of users) {
    identity.push(`INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES(${[
      userMaps.get(user.id), user.displayName.trim(), user.status, user.createdAt, user.updatedAt,
    ].map(sql).join(",")});`);
  }
  identity.push("COMMIT;");

  const core = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const user of users) {
    core.push(`INSERT INTO legacy_homemew_user_maps(legacy_user_id,lifespace_user_id,display_name_snapshot,source_status,migrated_at) VALUES(${[
      user.id, userMaps.get(user.id), user.displayName.trim(), user.status, migratedAt,
    ].map(sql).join(",")});`);
  }
  for (const family of families) {
    const spaceId = familyMaps.get(family.id);
    const deletedAt = family.status === "archived" ? family.updatedAt : null;
    core.push(`INSERT INTO spaces(id,kind,name,timezone,created_by_user_id,created_at,updated_at,version,deleted_at) VALUES(${[
      spaceId, "family", family.name.trim(), family.timezone, userMaps.get(family.createdBy), family.createdAt, family.updatedAt, 1, deletedAt,
    ].map(sql).join(",")});`);
    core.push(`INSERT INTO legacy_homemew_family_maps(legacy_family_id,space_id,legacy_created_by_user_id,migrated_at) VALUES(${[
      family.id, spaceId, family.createdBy, migratedAt,
    ].map(sql).join(",")});`);
  }
  const membershipManifest = [];
  for (const member of members) {
    const spaceId = familyMaps.get(member.familyId);
    const userId = userMaps.get(member.userId);
    const membershipId = deterministicId("mem", "homemew-membership", member.id);
    const personId = deterministicId("per", "homemew-person", member.id);
    const owner = ownerByFamily.get(member.familyId);
    const role = owner?.id === member.id ? "owner" : member.role === "admin" ? "admin" : "editor";
    const deletedAt = member.status === "removed" ? (member.removedAt ?? member.updatedAt) : null;
    core.push(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at,version,deleted_at) VALUES(${[
      membershipId, spaceId, userId, role, member.joinedAt, member.updatedAt, 1, deletedAt,
    ].map(sql).join(",")});`);
    core.push(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at,deleted_at) VALUES(${[
      personId, spaceId, userId, usersById.get(member.userId).displayName.trim(), member.joinedAt, member.updatedAt, deletedAt,
    ].map(sql).join(",")});`);
    core.push(`INSERT INTO legacy_homemew_membership_maps(legacy_membership_id,membership_id,person_id,legacy_family_id,legacy_user_id,migrated_at) VALUES(${[
      member.id, membershipId, personId, member.familyId, member.userId, migratedAt,
    ].map(sql).join(",")});`);
    membershipManifest.push({ legacyMembershipId: member.id, membershipId, personId });
  }
  for (const invite of invites) {
    const inviteId = /^inv_[A-Za-z0-9]+$/.test(invite.id) ? invite.id : deterministicId("inv", "homemew-invite", invite.id);
    core.push(`INSERT INTO space_invites(id,space_id,token_hash,token_prefix,role,expires_at,max_uses,used_count,status,created_by_user_id,created_at,updated_at,revoked_by_user_id,revoked_at) VALUES(${[
      inviteId, familyMaps.get(invite.familyId), invite.codeHash.toLowerCase(), invite.codePrefix ?? invite.id.slice(0, 7), "editor",
      invite.expiresAt, invite.maxUses, 0, invite.status === "revoked" ? "revoked" : "active", userMaps.get(invite.createdBy),
      invite.createdAt, invite.updatedAt, invite.revokedBy ? userMaps.get(invite.revokedBy) : null, invite.revokedAt ?? null,
    ].map(sql).join(",")});`);
    core.push(`INSERT INTO legacy_homemew_invite_maps(legacy_invite_id,invite_id,legacy_family_id,migrated_at) VALUES(${[
      invite.id, inviteId, invite.familyId, migratedAt,
    ].map(sql).join(",")});`);
  }
  for (const redemption of migratedRedemptions) {
    const invite = invitesById.get(redemption.inviteId);
    const inviteId = /^inv_[A-Za-z0-9]+$/.test(invite.id) ? invite.id : deterministicId("inv", "homemew-invite", invite.id);
    const redemptionId = /^ired_[A-Za-z0-9]+$/.test(redemption.id) ? redemption.id : deterministicId("ird", "homemew-redemption", redemption.id);
    core.push(`INSERT INTO space_invite_redemptions(id,invite_id,space_id,user_id,redeemed_at) VALUES(${[
      redemptionId, inviteId, familyMaps.get(redemption.familyId), userMaps.get(redemption.userId), redemption.redeemedAt,
    ].map(sql).join(",")});`);
  }
  for (const invite of invites) {
    const inviteId = /^inv_[A-Za-z0-9]+$/.test(invite.id) ? invite.id : deterministicId("inv", "homemew-invite", invite.id);
    core.push(`UPDATE space_invites SET used_count=${sql(invite.usedCount)},updated_at=${sql(invite.updatedAt)} WHERE id=${sql(inviteId)};`);
  }
  core.push("COMMIT;");

  const manifest = {
    version: 1,
    source: { schemaVersion: String(source.schemaVersion), exportedAt: migratedAt, commit: source.commit ?? null },
    users: users.map((user) => ({ legacyUserId: user.id, lifespaceUserId: userMaps.get(user.id) })),
    families: families.map((family) => ({ legacyFamilyId: family.id, spaceId: familyMaps.get(family.id) })),
    memberships: membershipManifest,
  };
  const report = {
    status: "ready",
    sourceCounts: { users: users.length, families: families.length, memberships: members.length, invites: invites.length, inviteRedemptions: redemptions.length },
    targetCounts: { identityUsers: users.length, familySpaces: families.length, memberships: members.length, spacePeople: members.length, invites: invites.length, inviteRedemptions: migratedRedemptions.length },
    collapsedHistoricalInviteRedemptions: collapsedRedemptions,
    deferredObjects: {
      userAvatars: users.filter((user) => user.avatarKey).length,
      familyAvatars: families.filter((family) => family.avatarKey).length,
    },
  };
  return { identitySql: `${identity.join("\n")}\n`, coreSql: `${core.join("\n")}\n`, manifest, report };
}

async function main(argv) {
  const inputIndex = argv.indexOf("--input");
  const outputIndex = argv.indexOf("--out-dir");
  if (inputIndex < 0 || outputIndex < 0 || !argv[inputIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error("Usage: node scripts/homemew-family-transform.mjs --input snapshot.json --out-dir DIR");
  }
  const inputPath = path.resolve(argv[inputIndex + 1]);
  const outputDir = path.resolve(argv[outputIndex + 1]);
  const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
  const result = transformSnapshot(snapshot);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "identity.sql"), result.identitySql),
    writeFile(path.join(outputDir, "core.sql"), result.coreSql),
    writeFile(path.join(outputDir, "mapping-manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "migration-report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

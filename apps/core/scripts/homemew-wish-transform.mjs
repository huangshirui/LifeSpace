import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

function fail(message) { throw new Error(`HomeMew wish snapshot is invalid: ${message}`); }
function array(value, field) { if (!Array.isArray(value)) fail(`${field} must be an array`); return value; }
function string(value, field) { if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`); return value; }
function instant(value, field) {
  const result = string(value, field);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(`${field} must be an RFC 3339 UTC instant`);
  return new Date(result).toISOString();
}
function date(value, field, nullable = false) {
  if (value == null && nullable) return null;
  const result = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(`${field} must be YYYY-MM-DD${nullable ? " or null" : ""}`);
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) fail(`${field} must be a valid date`);
  return result;
}
function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
function unique(items, label) {
  const map = new Map();
  for (const item of items) {
    const id = string(item.id, `${label}.id`);
    if (map.has(id)) fail(`${label} contains duplicate id ${id}`);
    map.set(id, item);
  }
  return map;
}

export function transformWishSnapshot(snapshot, familyManifest) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("root must be an object");
  if (!familyManifest || typeof familyManifest !== "object" || Array.isArray(familyManifest)) fail("family mapping manifest must be an object");
  const source = snapshot.source ?? {};
  if (String(source.schemaVersion) !== "11") fail("source.schemaVersion must be 11");
  const exportedAt = instant(source.exportedAt, "source.exportedAt");
  if (familyManifest.source?.schemaVersion !== "11") fail("family mapping manifest must target schema 11");
  if (familyManifest.source?.exportedAt !== exportedAt) fail("snapshot and family mapping manifest exportedAt must match");

  const users = array(snapshot.users, "users");
  const members = array(snapshot.familyMembers, "familyMembers");
  const wishes = array(snapshot.wishes, "wishes");
  const usersById = unique(users, "users");
  unique(wishes, "wishes");

  const familyByLegacyId = new Map(array(familyManifest.families, "familyManifest.families")
    .map((item) => [string(item.legacyFamilyId, "familyManifest family id"), string(item.spaceId, "familyManifest space id")]));
  const userByLegacyId = new Map(array(familyManifest.users, "familyManifest.users")
    .map((item) => [string(item.legacyUserId, "familyManifest user id"), string(item.lifespaceUserId, "familyManifest LifeSpace user id")]));
  const membershipByLegacyId = new Map(array(familyManifest.memberships, "familyManifest.memberships")
    .map((item) => [string(item.legacyMembershipId, "familyManifest membership id"), string(item.personId, "familyManifest person id")]));

  const memberByFamilyUser = new Map();
  for (const member of members) {
    const membershipId = string(member.id, "familyMembers.id");
    const familyId = string(member.familyId, `membership ${membershipId}.familyId`);
    const userId = string(member.userId, `membership ${membershipId}.userId`);
    if (!familyByLegacyId.has(familyId)) fail(`membership ${membershipId} has no family mapping`);
    if (!userByLegacyId.has(userId)) fail(`membership ${membershipId} has no user mapping`);
    if (!membershipByLegacyId.has(membershipId)) fail(`membership ${membershipId} has no person mapping`);
    if (!["active", "removed"].includes(member.status)) fail(`membership ${membershipId} has invalid status`);
    const key = `${familyId}\0${userId}`;
    if (memberByFamilyUser.has(key)) fail(`duplicate membership for ${familyId}/${userId}`);
    memberByFamilyUser.set(key, member);
  }

  function personFor(familyId, userId, field) {
    const id = string(userId, field);
    if (!usersById.has(id) || !userByLegacyId.has(id)) fail(`${field} has no user mapping`);
    const member = memberByFamilyUser.get(`${familyId}\0${id}`);
    if (!member) fail(`${field} has no family membership`);
    return { personId: membershipByLegacyId.get(member.id), member, legacyUserId: id };
  }

  function actor(owner, prefix, nullable = false) {
    const type = owner[`${prefix}ByType`];
    const sourceId = owner[`${prefix}ById`];
    if (nullable && type == null && sourceId == null) return null;
    if (type !== "user") fail(`${owner.id}.${prefix}ByType must be user`);
    const legacyUserId = string(sourceId, `${owner.id}.${prefix}ById`);
    const user = usersById.get(legacyUserId);
    const mappedId = userByLegacyId.get(legacyUserId);
    if (!user || !mappedId) fail(`${owner.id}.${prefix}ById has no user mapping`);
    return { type: "user", id: mappedId, name: string(user.displayName, `user ${legacyUserId}.displayName`) };
  }

  const rows = [];
  const historicalRemovedPeople = [];
  for (const wish of wishes) {
    if (!/^wsh_[A-Za-z0-9]+$/.test(wish.id)) fail(`wish ${wish.id} has an unsupported ID`);
    const spaceId = familyByLegacyId.get(wish.familyId);
    if (!spaceId) fail(`wish ${wish.id} has no family mapping`);
    const title = string(wish.title, `wish ${wish.id}.title`).trim();
    if (title.length > 100) fail(`wish ${wish.id}.title exceeds 100 characters`);
    if (wish.description != null && (typeof wish.description !== "string" || wish.description.length > 5000)) fail(`wish ${wish.id}.description is invalid`);
    const desiredDate = date(wish.desiredDate, `wish ${wish.id}.desiredDate`, true);
    if (!["open", "claimed", "fulfilled", "archived"].includes(wish.status)) fail(`wish ${wish.id}.status is invalid`);
    if (!Number.isInteger(wish.version) || wish.version < 1) fail(`wish ${wish.id}.version is invalid`);

    const owner = personFor(wish.familyId, wish.ownerUserId, `wish ${wish.id}.ownerUserId`);
    const claimant = wish.claimantUserId == null ? null : personFor(wish.familyId, wish.claimantUserId, `wish ${wish.id}.claimantUserId`);
    const fulfilledBy = wish.fulfilledByUserId == null ? null : personFor(wish.familyId, wish.fulfilledByUserId, `wish ${wish.id}.fulfilledByUserId`);
    const claimedAt = wish.claimedAt == null ? null : instant(wish.claimedAt, `wish ${wish.id}.claimedAt`);
    const fulfilledAt = wish.fulfilledAt == null ? null : instant(wish.fulfilledAt, `wish ${wish.id}.fulfilledAt`);
    const archivedFromStatus = wish.archivedFromStatus == null ? null : wish.archivedFromStatus;
    if (archivedFromStatus !== null && !["open", "claimed", "fulfilled"].includes(archivedFromStatus)) fail(`wish ${wish.id}.archivedFromStatus is invalid`);
    if ((claimant === null) !== (claimedAt === null)) fail(`wish ${wish.id} claimant and claimedAt must both be null or present`);
    if ((fulfilledBy === null) !== (fulfilledAt === null)) fail(`wish ${wish.id} fulfilledBy and fulfilledAt must both be null or present`);

    if (wish.status === "open" && (claimant || fulfilledBy || archivedFromStatus)) fail(`open wish ${wish.id} has incompatible lifecycle fields`);
    if (wish.status === "claimed" && (!claimant || fulfilledBy || archivedFromStatus)) fail(`claimed wish ${wish.id} has incompatible lifecycle fields`);
    if (wish.status === "fulfilled" && (!fulfilledBy || archivedFromStatus)) fail(`fulfilled wish ${wish.id} has incompatible lifecycle fields`);
    if (wish.status === "archived" && !archivedFromStatus) fail(`archived wish ${wish.id} must preserve archivedFromStatus`);

    const createdBy = actor(wish, "created");
    const updatedBy = actor(wish, "updated");
    const deletedBy = actor(wish, "deleted", true);
    const createdAt = instant(wish.createdAt, `wish ${wish.id}.createdAt`);
    const updatedAt = instant(wish.updatedAt, `wish ${wish.id}.updatedAt`);
    const deletedAt = wish.deletedAt == null ? null : instant(wish.deletedAt, `wish ${wish.id}.deletedAt`);
    if ((deletedAt === null) !== (deletedBy === null)) fail(`wish ${wish.id} deleted actor and timestamp must both be null or present`);

    for (const [role, relation] of [["owner", owner], ["claimant", claimant], ["fulfilledBy", fulfilledBy]]) {
      if (relation?.member.status === "removed") historicalRemovedPeople.push({ wishId: wish.id, role, legacyUserId: relation.legacyUserId, personId: relation.personId });
    }

    rows.push({ wish, spaceId, title, desiredDate, owner, claimant, fulfilledBy, claimedAt, fulfilledAt, archivedFromStatus, createdBy, updatedBy, deletedBy, createdAt, updatedAt, deletedAt });
  }

  const statements = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const row of rows) {
    statements.push(`INSERT INTO wishes(\nid,space_id,owner_person_id,title,description,desired_date,status,claimant_person_id,claimed_at,fulfilled_by_person_id,fulfilled_at,archived_from_status,\ncreated_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,version,created_at,updated_at,\ndeleted_at,deleted_by_type,deleted_by_id,mutation_token) VALUES(${[
      row.wish.id, row.spaceId, row.owner.personId, row.title, row.wish.description ?? null, row.desiredDate, row.wish.status,
      row.claimant?.personId ?? null, row.claimedAt, row.fulfilledBy?.personId ?? null, row.fulfilledAt, row.archivedFromStatus,
      row.createdBy.type, row.createdBy.id, row.createdBy.name, row.updatedBy.type, row.updatedBy.id, row.updatedBy.name,
      row.wish.version, row.createdAt, row.updatedAt, row.deletedAt, row.deletedBy?.type ?? null, row.deletedBy?.id ?? null, null,
    ].map(sql).join(",")});`);
  }
  statements.push("COMMIT;");

  return {
    coreSql: `${statements.join("\n")}\n`,
    manifest: {
      version: 1,
      source: { schemaVersion: "11", exportedAt, commit: source.commit ?? null },
      wishes: rows.map((row) => ({ legacyWishId: row.wish.id, wishId: row.wish.id })),
    },
    report: {
      status: "ready",
      sourceCounts: { wishes: wishes.length },
      targetCounts: { wishes: rows.length },
      statuses: Object.fromEntries(["open", "claimed", "fulfilled", "archived"].map((status) => [status, rows.filter((row) => row.wish.status === status).length])),
      softDeleted: rows.filter((row) => row.deletedAt !== null).length,
      historicalPeopleFromRemovedMemberships: historicalRemovedPeople,
      archivedClaimedWithRemovedClaimant: rows.filter((row) => row.wish.status === "archived" && row.archivedFromStatus === "claimed" && row.claimant?.member.status === "removed")
        .map((row) => ({ wishId: row.wish.id, legacyUserId: row.claimant.legacyUserId, personId: row.claimant.personId })),
    },
  };
}

async function main(argv) {
  const inputIndex = argv.indexOf("--input");
  const manifestIndex = argv.indexOf("--family-manifest");
  const outputIndex = argv.indexOf("--out-dir");
  if (inputIndex < 0 || manifestIndex < 0 || outputIndex < 0 || !argv[inputIndex + 1] || !argv[manifestIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error("Usage: node scripts/homemew-wish-transform.mjs --input snapshot.json --family-manifest mapping-manifest.json --out-dir DIR");
  }
  const snapshot = JSON.parse(await readFile(path.resolve(argv[inputIndex + 1]), "utf8"));
  const familyManifest = JSON.parse(await readFile(path.resolve(argv[manifestIndex + 1]), "utf8"));
  const outputDir = path.resolve(argv[outputIndex + 1]);
  const result = transformWishSnapshot(snapshot, familyManifest);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "core-wishes.sql"), result.coreSql),
    writeFile(path.join(outputDir, "wish-mapping-manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "wish-migration-report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

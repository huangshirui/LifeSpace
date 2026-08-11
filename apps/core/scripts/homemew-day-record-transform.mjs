import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

function fail(message) { throw new Error(`HomeMew day-record snapshot is invalid: ${message}`); }
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
function integer(value, field, min, max, nullable = false) {
  if (value == null && nullable) return null;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${field} must be ${nullable ? "null or " : ""}an integer between ${min} and ${max}`);
  return value;
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
function dateOrdinal(value) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}
function addDateDays(value, days) {
  return new Date((dateOrdinal(value) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function transformDayRecordSnapshot(snapshot, familyManifest) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("root must be an object");
  if (!familyManifest || typeof familyManifest !== "object" || Array.isArray(familyManifest)) fail("family mapping manifest must be an object");
  const source = snapshot.source ?? {};
  if (String(source.schemaVersion) !== "11") fail("source.schemaVersion must be 11");
  const exportedAt = instant(source.exportedAt, "source.exportedAt");
  if (familyManifest.source?.schemaVersion !== "11") fail("family mapping manifest must target schema 11");
  if (familyManifest.source?.exportedAt !== exportedAt) fail("snapshot and family mapping manifest exportedAt must match");

  const users = array(snapshot.users, "users");
  const systems = array(snapshot.systemIdentities ?? [], "systemIdentities");
  const members = array(snapshot.familyMembers, "familyMembers");
  const records = array(snapshot.dayRecords, "dayRecords");
  const occurrences = array(snapshot.dayRecordOccurrences ?? [], "dayRecordOccurrences");
  const usersById = unique(users, "users");
  const systemsById = unique(systems, "systemIdentities");
  const recordsById = unique(records, "dayRecords");
  const occurrenceIds = new Set();

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

  function actor(owner, prefix, nullable = false) {
    const sourceType = owner[`${prefix}ByType`];
    const sourceId = owner[`${prefix}ById`];
    if (nullable && sourceType == null && sourceId == null) return null;
    if (sourceType !== "user" && sourceType !== "system") fail(`${owner.id}.${prefix}ByType is invalid`);
    const id = string(sourceId, `${owner.id}.${prefix}ById`);
    if (sourceType === "user") {
      const user = usersById.get(id);
      const mappedId = userByLegacyId.get(id);
      if (!user || !mappedId) fail(`${owner.id}.${prefix}ById has no user mapping`);
      return { type: "user", id: mappedId, name: string(user.displayName, `user ${id}.displayName`) };
    }
    const system = systemsById.get(id);
    return { type: "service", id, name: system ? string(system.name, `system ${id}.name`) : id };
  }

  const rows = [];
  const manifestRecords = [];
  const removedSubjectRecords = [];
  for (const record of records) {
    if (!/^day_[A-Za-z0-9]+$/.test(record.id)) fail(`day record ${record.id} has an unsupported ID`);
    const spaceId = familyByLegacyId.get(record.familyId);
    if (!spaceId) fail(`day record ${record.id} has no family mapping`);
    const name = string(record.name, `day record ${record.id}.name`).trim();
    if (name.length > 100) fail(`day record ${record.id}.name exceeds 100 characters`);
    if (record.description != null && (typeof record.description !== "string" || record.description.length > 5000)) fail(`day record ${record.id}.description is invalid`);
    if (record.icon != null && (typeof record.icon !== "string" || record.icon.length > 50)) fail(`day record ${record.id}.icon is invalid`);
    if (!["elapsed", "countdown", "cycle"].includes(record.kind)) fail(`day record ${record.id}.kind is invalid`);
    const anchorDate = date(record.anchorDate, `day record ${record.id}.anchorDate`);
    const cycleDays = integer(record.cycleDays, `day record ${record.id}.cycleDays`, 1, 3650, true);
    const nextDueDate = date(record.nextDueDate, `day record ${record.id}.nextDueDate`, true);
    const attentionBeforeDays = integer(record.attentionBeforeDays, `day record ${record.id}.attentionBeforeDays`, 0, 3650, true);
    const attentionAfterDays = integer(record.attentionAfterDays, `day record ${record.id}.attentionAfterDays`, 1, 3650, true);
    if (record.kind === "elapsed" && (cycleDays !== null || nextDueDate !== null || attentionBeforeDays !== null)) fail(`elapsed day record ${record.id} has incompatible rule fields`);
    if (record.kind === "countdown" && (cycleDays !== null || nextDueDate !== null || attentionAfterDays !== null)) fail(`countdown day record ${record.id} has incompatible rule fields`);
    if (record.kind === "cycle") {
      if (cycleDays === null || nextDueDate === null || attentionAfterDays !== null) fail(`cycle day record ${record.id} has incompatible rule fields`);
      if (nextDueDate !== addDateDays(anchorDate, cycleDays)) fail(`cycle day record ${record.id}.nextDueDate is inconsistent with anchorDate/cycleDays`);
    }
    let subjectPersonId = null;
    if (record.subjectUserId != null) {
      const userId = string(record.subjectUserId, `day record ${record.id}.subjectUserId`);
      if (!usersById.has(userId)) fail(`day record ${record.id} subject references missing user ${userId}`);
      const member = memberByFamilyUser.get(`${record.familyId}\0${userId}`);
      if (!member) fail(`day record ${record.id} subject has no family membership`);
      subjectPersonId = membershipByLegacyId.get(member.id);
      if (member.status === "removed") removedSubjectRecords.push({ dayRecordId: record.id, legacyUserId: userId, personId: subjectPersonId });
    }
    if (!["active", "archived"].includes(record.status)) fail(`day record ${record.id}.status is invalid`);
    if (!Number.isInteger(record.version) || record.version < 1) fail(`day record ${record.id}.version is invalid`);
    const createdBy = actor(record, "created");
    const updatedBy = actor(record, "updated");
    const deletedBy = actor(record, "deleted", true);
    const createdAt = instant(record.createdAt, `day record ${record.id}.createdAt`);
    const updatedAt = instant(record.updatedAt, `day record ${record.id}.updatedAt`);
    const deletedAt = record.deletedAt == null ? null : instant(record.deletedAt, `day record ${record.id}.deletedAt`);
    if ((deletedAt === null) !== (deletedBy === null)) fail(`day record ${record.id} deleted actor and timestamp must both be null or present`);
    rows.push({ record, spaceId, name, anchorDate, cycleDays, nextDueDate, attentionBeforeDays, attentionAfterDays, subjectPersonId, createdBy, updatedBy, deletedBy, createdAt, updatedAt, deletedAt });
    manifestRecords.push({ legacyDayRecordId: record.id, dayRecordId: record.id });
  }

  const occurrenceRows = [];
  const occurrenceDates = new Map();
  for (const occurrence of occurrences) {
    const id = string(occurrence.id, "dayRecordOccurrences.id");
    if (!/^dyo_[A-Za-z0-9]+$/.test(id)) fail(`occurrence ${id} has an unsupported ID`);
    if (occurrenceIds.has(id)) fail(`duplicate occurrence id ${id}`);
    occurrenceIds.add(id);
    const record = recordsById.get(occurrence.dayRecordId);
    if (!record) fail(`occurrence ${id} references missing day record ${occurrence.dayRecordId}`);
    if (record.kind === "countdown") fail(`countdown day record ${record.id} cannot have occurrences`);
    const occurredOn = date(occurrence.occurredOn, `occurrence ${id}.occurredOn`);
    if (occurrence.note != null && (typeof occurrence.note !== "string" || occurrence.note.length > 1000)) fail(`occurrence ${id}.note is invalid`);
    if (!['initial', 'manual'].includes(occurrence.source)) fail(`occurrence ${id}.source is invalid`);
    const recordedBy = actor(occurrence, "recorded");
    const createdAt = instant(occurrence.createdAt, `occurrence ${id}.createdAt`);
    const pair = `${occurrence.dayRecordId}\0${occurredOn}`;
    if (occurrenceDates.has(pair)) fail(`duplicate occurrence date ${occurrence.dayRecordId}/${occurredOn}`);
    occurrenceDates.set(pair, occurrence);
    occurrenceRows.push({ occurrence, occurredOn, recordedBy, createdAt });
  }

  for (const record of records) {
    const own = occurrenceRows.filter((row) => row.occurrence.dayRecordId === record.id);
    if (record.kind === "countdown") {
      if (own.length) fail(`countdown day record ${record.id} cannot have occurrence history`);
      continue;
    }
    if (!own.length) fail(`day record ${record.id} must have occurrence history`);
    const initial = own.filter((row) => row.occurrence.source === "initial");
    if (initial.length !== 1) fail(`day record ${record.id} must have exactly one initial occurrence`);
    const latestDate = own.map((row) => row.occurredOn).sort().at(-1);
    if (latestDate !== record.anchorDate) fail(`day record ${record.id}.anchorDate must equal its latest occurrence date`);
  }

  const statements = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const row of rows) {
    statements.push(`INSERT INTO day_records(
id,space_id,name,description,kind,anchor_date,cycle_days,next_due_date,attention_before_days,attention_after_days,subject_person_id,icon,status,
created_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,version,created_at,updated_at,
deleted_at,deleted_by_type,deleted_by_id,mutation_token) VALUES(${[
      row.record.id, row.spaceId, row.name, row.record.description ?? null, row.record.kind, row.anchorDate, row.cycleDays, row.nextDueDate,
      row.attentionBeforeDays, row.attentionAfterDays, row.subjectPersonId, row.record.icon ?? null, row.record.status,
      row.createdBy.type, row.createdBy.id, row.createdBy.name, row.updatedBy.type, row.updatedBy.id, row.updatedBy.name,
      row.record.version, row.createdAt, row.updatedAt, row.deletedAt, row.deletedBy?.type ?? null, row.deletedBy?.id ?? null, null,
    ].map(sql).join(",")});`);
  }
  for (const row of occurrenceRows) {
    statements.push(`INSERT INTO day_record_occurrences(
id,day_record_id,occurred_on,note,source,recorded_by_type,recorded_by_id,recorded_by_name_snapshot,created_at) VALUES(${[
      row.occurrence.id, row.occurrence.dayRecordId, row.occurredOn, row.occurrence.note ?? null, row.occurrence.source,
      row.recordedBy.type, row.recordedBy.id, row.recordedBy.name, row.createdAt,
    ].map(sql).join(",")});`);
  }
  statements.push("COMMIT;");

  const actors = [
    ...rows.flatMap((row) => [row.createdBy, row.updatedBy, row.deletedBy]),
    ...occurrenceRows.map((row) => row.recordedBy),
  ].filter(Boolean);
  return {
    coreSql: `${statements.join("\n")}\n`,
    manifest: { version: 1, source: { schemaVersion: "11", exportedAt, commit: source.commit ?? null }, dayRecords: manifestRecords },
    report: {
      status: "ready",
      sourceCounts: { dayRecords: records.length, dayRecordOccurrences: occurrences.length },
      targetCounts: { dayRecords: rows.length, dayRecordOccurrences: occurrenceRows.length },
      kinds: {
        elapsed: rows.filter((row) => row.record.kind === "elapsed").length,
        countdown: rows.filter((row) => row.record.kind === "countdown").length,
        cycle: rows.filter((row) => row.record.kind === "cycle").length,
      },
      archived: rows.filter((row) => row.record.status === "archived").length,
      softDeleted: rows.filter((row) => row.deletedAt !== null).length,
      historicalSubjectsFromRemovedMemberships: removedSubjectRecords,
      preservedSystemActorIds: [...new Set(actors.filter((value) => value.type === "service").map((value) => value.id))],
    },
  };
}

async function main(argv) {
  const inputIndex = argv.indexOf("--input");
  const manifestIndex = argv.indexOf("--family-manifest");
  const outputIndex = argv.indexOf("--out-dir");
  if (inputIndex < 0 || manifestIndex < 0 || outputIndex < 0 || !argv[inputIndex + 1] || !argv[manifestIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error("Usage: node scripts/homemew-day-record-transform.mjs --input snapshot.json --family-manifest mapping-manifest.json --out-dir DIR");
  }
  const snapshot = JSON.parse(await readFile(path.resolve(argv[inputIndex + 1]), "utf8"));
  const familyManifest = JSON.parse(await readFile(path.resolve(argv[manifestIndex + 1]), "utf8"));
  const outputDir = path.resolve(argv[outputIndex + 1]);
  const result = transformDayRecordSnapshot(snapshot, familyManifest);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "core-day-records.sql"), result.coreSql),
    writeFile(path.join(outputDir, "day-record-mapping-manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "day-record-migration-report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

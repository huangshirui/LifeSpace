import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

function fail(message) {
  throw new Error(`HomeMew event snapshot is invalid: ${message}`);
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
  return new Date(result).toISOString();
}

function date(value, field) {
  const result = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(`${field} must be YYYY-MM-DD`);
  const [year, month, day] = result.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    fail(`${field} must be a valid date`);
  }
  return result;
}

function timezone(value, field) {
  if (value === null || value === undefined) return null;
  const result = string(value, field);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: result }).format(new Date(0));
  } catch {
    fail(`${field} must be an IANA timezone or null`);
  }
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

function unique(items, label) {
  const map = new Map();
  for (const item of items) {
    const id = string(item.id, `${label}.id`);
    if (map.has(id)) fail(`${label} contains duplicate id ${id}`);
    map.set(id, item);
  }
  return map;
}

function eventTime(event) {
  if (typeof event.isAllDay !== "boolean") fail(`event ${event.id}.isAllDay must be boolean`);
  if (event.isAllDay) {
    if (event.startAt != null || event.endAt != null || event.startTimezone != null || event.endTimezone != null) {
      fail(`all-day event ${event.id} contains timed fields`);
    }
    const startDate = date(event.startDate, `event ${event.id}.startDate`);
    const endDate = date(event.endDateExclusive, `event ${event.id}.endDateExclusive`);
    if (endDate <= startDate) fail(`event ${event.id} has a non-positive all-day range`);
    return { isAllDay: 1, startAt: null, endAt: null, startDate, endDate, startTimezone: null, endTimezone: null };
  }
  if (event.startDate != null || event.endDateExclusive != null) fail(`timed event ${event.id} contains all-day fields`);
  const startAt = instant(event.startAt, `event ${event.id}.startAt`);
  const endAt = instant(event.endAt, `event ${event.id}.endAt`);
  if (endAt <= startAt) fail(`event ${event.id} has a non-positive timed range`);
  return {
    isAllDay: 0,
    startAt,
    endAt,
    startDate: null,
    endDate: null,
    startTimezone: timezone(event.startTimezone, `event ${event.id}.startTimezone`),
    endTimezone: timezone(event.endTimezone, `event ${event.id}.endTimezone`),
  };
}

export function transformEventSnapshot(snapshot, familyManifest) {
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
  const events = array(snapshot.events, "events");
  const attendees = array(snapshot.eventAttendees ?? [], "eventAttendees");
  const usersById = unique(users, "users");
  const systemsById = unique(systems, "systemIdentities");
  const eventsById = unique(events, "events");
  const familyByLegacyId = new Map(array(familyManifest.families, "familyManifest.families")
    .map((item) => [string(item.legacyFamilyId, "familyManifest family id"), string(item.spaceId, "familyManifest space id")]));
  const userByLegacyId = new Map(array(familyManifest.users, "familyManifest.users")
    .map((item) => [string(item.legacyUserId, "familyManifest user id"), string(item.lifespaceUserId, "familyManifest LifeSpace user id")]));
  const membershipByLegacyId = new Map(array(familyManifest.memberships, "familyManifest.memberships")
    .map((item) => [string(item.legacyMembershipId, "familyManifest membership id"), string(item.personId, "familyManifest person id")]));

  const memberByFamilyUser = new Map();
  for (const member of members) {
    string(member.id, "familyMembers.id");
    string(member.familyId, `membership ${member.id}.familyId`);
    string(member.userId, `membership ${member.id}.userId`);
    if (!familyByLegacyId.has(member.familyId)) fail(`membership ${member.id} has no family mapping`);
    if (!userByLegacyId.has(member.userId)) fail(`membership ${member.id} has no user mapping`);
    if (!membershipByLegacyId.has(member.id)) fail(`membership ${member.id} has no person mapping`);
    if (!["active", "removed"].includes(member.status)) fail(`membership ${member.id} has invalid status`);
    const key = `${member.familyId}\0${member.userId}`;
    if (memberByFamilyUser.has(key)) fail(`duplicate membership for ${member.familyId}/${member.userId}`);
    memberByFamilyUser.set(key, member);
  }

  function actor(event, prefix, nullable = false) {
    const sourceType = event[`${prefix}ByType`];
    const sourceId = event[`${prefix}ById`];
    if (nullable && sourceType == null && sourceId == null) return null;
    if (sourceType !== "user" && sourceType !== "system") fail(`event ${event.id}.${prefix}ByType is invalid`);
    const id = string(sourceId, `event ${event.id}.${prefix}ById`);
    if (sourceType === "user") {
      const user = usersById.get(id);
      const mappedId = userByLegacyId.get(id);
      if (!user || !mappedId) fail(`event ${event.id}.${prefix}ById has no user mapping`);
      return { type: "user", id: mappedId, name: string(user.displayName, `user ${id}.displayName`) };
    }
    const system = systemsById.get(id);
    return { type: "service", id, name: system ? string(system.name, `system ${id}.name`) : id };
  }

  const eventManifest = [];
  const eventRows = [];
  for (const event of events) {
    if (!/^evt_[A-Za-z0-9]+$/.test(event.id)) fail(`event ${event.id} has an unsupported ID`);
    const spaceId = familyByLegacyId.get(event.familyId);
    if (!spaceId) fail(`event ${event.id} has no family mapping`);
    const summary = string(event.summary, `event ${event.id}.summary`).trim();
    if (summary.length > 100) fail(`event ${event.id}.summary exceeds 100 characters`);
    if (event.description != null && (typeof event.description !== "string" || event.description.length > 5000)) fail(`event ${event.id}.description is invalid`);
    if (event.location != null && (typeof event.location !== "string" || event.location.length > 500)) fail(`event ${event.id}.location is invalid`);
    if (!["active", "cancelled"].includes(event.status)) fail(`event ${event.id}.status is invalid`);
    if (!Number.isInteger(event.version) || event.version < 1) fail(`event ${event.id}.version is invalid`);
    const time = eventTime(event);
    const createdBy = actor(event, "created");
    const updatedBy = actor(event, "updated");
    const deletedBy = actor(event, "deleted", true);
    const createdAt = instant(event.createdAt, `event ${event.id}.createdAt`);
    const updatedAt = instant(event.updatedAt, `event ${event.id}.updatedAt`);
    const deletedAt = event.deletedAt == null ? null : instant(event.deletedAt, `event ${event.id}.deletedAt`);
    if ((deletedAt === null) !== (deletedBy === null)) fail(`event ${event.id} deleted actor and timestamp must both be null or present`);
    eventRows.push({ event, spaceId, time, createdBy, updatedBy, deletedBy, createdAt, updatedAt, deletedAt });
    eventManifest.push({ legacyEventId: event.id, eventId: event.id });
  }

  const seenAttendees = new Set();
  const attendeeRows = [];
  const hiddenAttendees = [];
  for (const attendee of attendees) {
    const event = eventsById.get(attendee.eventId);
    if (!event) fail(`attendee references missing event ${attendee.eventId}`);
    if (!usersById.has(attendee.userId)) fail(`attendee ${attendee.eventId}/${attendee.userId} references missing user`);
    const member = memberByFamilyUser.get(`${event.familyId}\0${attendee.userId}`);
    if (!member) fail(`attendee ${attendee.eventId}/${attendee.userId} has no family membership`);
    const pair = `${attendee.eventId}\0${attendee.userId}`;
    if (seenAttendees.has(pair)) fail(`duplicate attendee ${attendee.eventId}/${attendee.userId}`);
    seenAttendees.add(pair);
    attendeeRows.push({ eventId: attendee.eventId, personId: membershipByLegacyId.get(member.id), createdAt: instant(attendee.createdAt, `attendee ${pair}.createdAt`) });
    if (member.status === "removed") hiddenAttendees.push({ eventId: attendee.eventId, legacyUserId: attendee.userId });
  }

  const statements = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const row of eventRows) {
    statements.push(`INSERT INTO events(
id,space_id,summary,description,start_at,end_at,start_date,end_date,is_all_day,start_timezone,end_timezone,location,status,
created_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,
version,created_at,updated_at,deleted_at,deleted_by_type,deleted_by_id,mutation_token) VALUES(${[
      row.event.id, row.spaceId, row.event.summary.trim(), row.event.description ?? null,
      row.time.startAt, row.time.endAt, row.time.startDate, row.time.endDate, row.time.isAllDay,
      row.time.startTimezone, row.time.endTimezone, row.event.location ?? null, row.event.status,
      row.createdBy.type, row.createdBy.id, row.createdBy.name,
      row.updatedBy.type, row.updatedBy.id, row.updatedBy.name,
      row.event.version, row.createdAt, row.updatedAt, row.deletedAt,
      row.deletedBy?.type ?? null, row.deletedBy?.id ?? null, null,
    ].map(sql).join(",")});`);
  }
  for (const row of attendeeRows) {
    statements.push(`INSERT INTO event_attendees(event_id,person_id,created_at) VALUES(${[
      row.eventId, row.personId, row.createdAt,
    ].map(sql).join(",")});`);
  }
  statements.push("COMMIT;");

  return {
    coreSql: `${statements.join("\n")}\n`,
    manifest: {
      version: 1,
      source: { schemaVersion: "11", exportedAt, commit: source.commit ?? null },
      events: eventManifest,
    },
    report: {
      status: "ready",
      sourceCounts: { events: events.length, eventAttendees: attendees.length },
      targetCounts: { events: eventRows.length, eventAttendees: attendeeRows.length },
      eventKinds: {
        timed: eventRows.filter((row) => row.time.isAllDay === 0).length,
        allDay: eventRows.filter((row) => row.time.isAllDay === 1).length,
        softDeleted: eventRows.filter((row) => row.deletedAt !== null).length,
      },
      attendeesHiddenByRemovedMembership: hiddenAttendees,
      preservedSystemActorIds: [...new Set(eventRows.flatMap((row) => [row.createdBy, row.updatedBy, row.deletedBy]
        .filter((actorValue) => actorValue?.type === "service").map((actorValue) => actorValue.id)))],
    },
  };
}

async function main(argv) {
  const inputIndex = argv.indexOf("--input");
  const manifestIndex = argv.indexOf("--family-manifest");
  const outputIndex = argv.indexOf("--out-dir");
  if (inputIndex < 0 || manifestIndex < 0 || outputIndex < 0
    || !argv[inputIndex + 1] || !argv[manifestIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error("Usage: node scripts/homemew-event-transform.mjs --input snapshot.json --family-manifest mapping-manifest.json --out-dir DIR");
  }
  const snapshot = JSON.parse(await readFile(path.resolve(argv[inputIndex + 1]), "utf8"));
  const familyManifest = JSON.parse(await readFile(path.resolve(argv[manifestIndex + 1]), "utf8"));
  const outputDir = path.resolve(argv[outputIndex + 1]);
  const result = transformEventSnapshot(snapshot, familyManifest);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "core-events.sql"), result.coreSql),
    writeFile(path.join(outputDir, "event-mapping-manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "event-migration-report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

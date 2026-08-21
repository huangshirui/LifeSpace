import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const IDENTITY_URL = "https://auth.aisr.online";
const CORE_URL = "https://core.aisr.online";
const SOURCE_ASSETS_PUBLIC_URL = "https://homemew-assets.aisr.online";
const USER_SCOPES = [
  "profile:read",
  "profile:write",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "resources:read",
  "resources:write",
];

function cliValue(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function api(base, path, token, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.json !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json === undefined ? undefined : JSON.stringify(options.json),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || !("data" in payload)) {
    throw new Error(`API verification request failed (${response.status})`);
  }
  return payload.data;
}

function sameArray(left, right) {
  return [...(left ?? [])].sort().join("\u0000") === [...(right ?? [])].sort().join("\u0000");
}

function sameIdSet(rows, key, mapping) {
  const left = rows.map((row) => row[key]).sort();
  const right = Object.keys(mapping ?? {}).sort();
  return sameArray(left, right);
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const list = result.get(row[key]) ?? [];
    list.push(row);
    result.set(row[key], list);
  }
  return result;
}

function valueEqual(actual, expected) {
  return (actual ?? null) === (expected ?? null);
}

function sourceObjectUrl(key) {
  return new URL(`${SOURCE_ASSETS_PUBLIC_URL}/${String(key).replace(/^\/+/, "")}`).toString();
}

async function objectDigest(key) {
  const response = await fetch(sourceObjectUrl(key));
  if (!response.ok) throw new Error(`Source object is not readable (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

const snapshot = JSON.parse(await readFile(resolve(cliValue("--snapshot")), "utf8"));
const report = JSON.parse(await readFile(resolve(cliValue("--report")), "utf8"));
const applicationSecret = requiredEnv("LIFESPACE_APPLICATION_SECRET");
if (!applicationSecret.startsWith("lsa_")) throw new Error("LIFESPACE_APPLICATION_SECRET must be an lsa_* credential");
if (report.result !== "PASS" || report?.verification?.result !== "PASS") throw new Error("Prior migration report is not PASS");

const mismatches = new Map();
const fail = (kind) => mismatches.set(kind, (mismatches.get(kind) ?? 0) + 1);

const data = snapshot.data ?? {};
const mappings = report.mappings ?? {};

for (const [kind, rows, key, map] of [
  ["users", data.users ?? [], "id", mappings.users],
  ["spaces", data.families ?? [], "id", mappings.spaces],
  ["memberships", data.familyMembers ?? [], "id", mappings.memberships],
  ["events", data.events ?? [], "id", mappings.events],
  ["tasks", data.tasks ?? [], "id", mappings.tasks],
  ["dayRecords", data.dayRecords ?? [], "id", mappings.dayRecords],
  ["wishes", data.wishes ?? [], "id", mappings.wishes],
]) {
  if (!sameIdSet(rows, key, map)) fail(`${kind}:identity-set`);
}

const peopleKeys = (data.familyMembers ?? []).map((row) => `${row.family_id}:${row.user_id}`).sort();
if (!sameArray(peopleKeys, Object.keys(mappings.people ?? {}).sort())) fail("people:identity-set");

const usersById = new Map((data.users ?? []).map((row) => [row.id, row]));
const familiesById = new Map((data.families ?? []).map((row) => [row.id, row]));
const membersByFamily = groupBy(data.familyMembers ?? [], "family_id");
const attendeesByEvent = groupBy(data.eventAttendees ?? [], "event_id");
const assigneesByTask = groupBy(data.taskAssignees ?? [], "task_id");
const occurrencesByDay = groupBy(data.dayRecordOccurrences ?? [], "day_record_id");

const tokens = new Map();
async function userToken(sourceUserId) {
  if (tokens.has(sourceUserId)) return tokens.get(sourceUserId);
  const targetUserId = mappings.users?.[sourceUserId];
  if (!targetUserId) throw new Error("Missing target user mapping");
  const token = await api(IDENTITY_URL, "/internal/v1/tokens", applicationSecret, {
    method: "POST",
    json: { subjectId: targetUserId, scopes: USER_SCOPES },
  });
  tokens.set(sourceUserId, token.accessToken);
  return token.accessToken;
}

function personId(familyId, sourceUserId) {
  if (sourceUserId == null) return null;
  return mappings.people?.[`${familyId}:${sourceUserId}`] ?? null;
}

for (const user of data.users ?? []) {
  const token = await userToken(user.id);
  const profile = await api(IDENTITY_URL, "/api/v1/me", token);
  if (profile.id !== mappings.users[user.id] || !valueEqual(profile.displayName, user.display_name)) fail("users:fields");
}

for (const family of data.families ?? []) {
  const ownerSourceId = family.created_by;
  const token = await userToken(ownerSourceId);
  const spaceId = mappings.spaces?.[family.id];
  const space = await api(CORE_URL, `/api/v1/spaces/${encodeURIComponent(spaceId)}`, token);
  if (space.id !== spaceId || !valueEqual(space.name, family.name) || !valueEqual(space.timezone, family.timezone)) fail("spaces:fields");

  const currentMembers = await api(CORE_URL, `/api/v1/spaces/${encodeURIComponent(spaceId)}/members`, token);
  const sourceMembers = membersByFamily.get(family.id) ?? [];
  if (currentMembers.length !== sourceMembers.length) {
    fail("memberships:count");
  } else {
    for (const member of sourceMembers) {
      const targetUserId = mappings.users?.[member.user_id];
      const current = currentMembers.find((item) => item.userId === targetUserId);
      const expectedRole = member.user_id === ownerSourceId ? "owner" : member.role === "admin" ? "admin" : "editor";
      if (!current || current.id !== mappings.memberships?.[member.id] || current.personId !== personId(family.id, member.user_id) || current.role !== expectedRole) {
        fail("memberships:fields");
      }
    }
  }
}

async function verifyResource(familyId, ownerSourceId, route, targetId, fields, arrayFields = []) {
  const token = await userToken(ownerSourceId);
  const spaceId = mappings.spaces?.[familyId];
  const current = await api(CORE_URL, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${route}/${encodeURIComponent(targetId)}`, token);
  for (const [field, expected] of Object.entries(fields)) {
    if (arrayFields.includes(field)) {
      if (!sameArray(current[field] ?? [], expected ?? [])) return false;
    } else if (!valueEqual(current[field], expected)) {
      return false;
    }
  }
  return true;
}

for (const event of data.events ?? []) {
  const family = familiesById.get(event.family_id);
  const attendeePersonIds = (attendeesByEvent.get(event.id) ?? []).map((row) => personId(event.family_id, row.user_id));
  const ok = await verifyResource(event.family_id, family.created_by, "events", mappings.events?.[event.id], {
    summary: event.summary,
    description: event.description,
    location: event.location,
    isAllDay: Boolean(event.is_all_day),
    startAt: event.start_at,
    endAt: event.end_at,
    startTimezone: event.start_timezone,
    endTimezone: event.end_timezone,
    startDate: event.start_date,
    endDateExclusive: event.end_date,
    attendeePersonIds,
    status: event.status,
  }, ["attendeePersonIds"]);
  if (!ok) fail("events:fields");
}

for (const task of data.tasks ?? []) {
  const family = familiesById.get(task.family_id);
  const assigneePersonIds = (assigneesByTask.get(task.id) ?? []).map((row) => personId(task.family_id, row.user_id));
  const ok = await verifyResource(task.family_id, family.created_by, "tasks", mappings.tasks?.[task.id], {
    name: task.name,
    description: task.description,
    dueDate: task.due_date,
    status: task.status,
    assigneePersonIds,
  }, ["assigneePersonIds"]);
  if (!ok) fail("tasks:fields");
}

for (const day of data.dayRecords ?? []) {
  const family = familiesById.get(day.family_id);
  const ok = await verifyResource(day.family_id, family.created_by, "day-records", mappings.dayRecords?.[day.id], {
    name: day.name,
    description: day.description,
    kind: day.kind,
    anchorDate: day.anchor_date,
    subjectPersonId: personId(day.family_id, day.subject_user_id),
    icon: day.icon,
    attentionAfterDays: day.kind === "elapsed" ? day.attention_after_days : null,
    attentionBeforeDays: day.kind === "countdown" || day.kind === "cycle" ? day.attention_before_days : null,
    cycleDays: day.kind === "cycle" ? day.cycle_days : null,
    status: day.status,
  });
  if (!ok) fail("dayRecords:fields");

  if (day.kind !== "countdown") {
    const token = await userToken(family.created_by);
    const spaceId = mappings.spaces?.[day.family_id];
    const result = await api(CORE_URL, `/api/v1/spaces/${encodeURIComponent(spaceId)}/day-records/${encodeURIComponent(mappings.dayRecords?.[day.id])}/occurrences?limit=200`, token);
    const expectedDates = (occurrencesByDay.get(day.id) ?? []).map((item) => item.occurred_on);
    const actualDates = (result.items ?? []).map((item) => item.occurredOn);
    if (!sameArray(actualDates, expectedDates)) fail("dayRecords:occurrences");
  }
}

for (const wish of data.wishes ?? []) {
  const family = familiesById.get(wish.family_id);
  const ok = await verifyResource(wish.family_id, family.created_by, "wishes", mappings.wishes?.[wish.id], {
    title: wish.title,
    description: wish.description,
    desiredDate: wish.desired_date,
    status: wish.status,
    ownerPersonId: personId(wish.family_id, wish.owner_user_id),
    claimantPersonId: personId(wish.family_id, wish.claimant_user_id),
    fulfilledByPersonId: personId(wish.family_id, wish.fulfilled_by_user_id),
    archivedFromStatus: wish.status === "archived" ? wish.archived_from_status : null,
  });
  if (!ok) fail("wishes:fields");
}

const expectedObjects = report?.verification?.objects ?? [];
const sourceAvatarRows = [
  ...(data.users ?? []).filter((row) => row.avatar_key).map((row) => ({ type: "user-avatar", sourceId: row.id, key: row.avatar_key })),
  ...(data.families ?? []).filter((row) => row.avatar_key).map((row) => ({ type: "space-avatar", sourceId: row.id, key: row.avatar_key })),
];
if (!sameArray(sourceAvatarRows.map((item) => `${item.type}:${item.sourceId}`), expectedObjects.map((item) => `${item.type}:${item.sourceId}`))) {
  fail("objects:identity-set");
} else {
  for (const object of sourceAvatarRows) {
    const expected = expectedObjects.find((item) => item.type === object.type && item.sourceId === object.sourceId);
    const digest = await objectDigest(object.key);
    if (!expected || digest.bytes !== expected.bytes || digest.sha256 !== expected.sha256) fail("objects:content");
  }
}

const reprovisioning = report.credentialReprovisioning ?? [];
const systems = data.systems ?? [];
if (!sameArray(systems.map((item) => item.id), reprovisioning.map((item) => item.sourceSystemId))) {
  fail("systems:identity-set");
} else {
  for (const system of systems) {
    const expected = reprovisioning.find((item) => item.sourceSystemId === system.id);
    const access = (data.systemAccess ?? []).find((item) => item.system_id === system.id && item.family_id === system.family_id);
    const credentials = (data.systemCredentials ?? [])
      .filter((item) => item.system_id === system.id)
      .map((item) => ({ credentialType: item.credential_type, status: item.status, expiresAt: item.expires_at, count: item.credential_count }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expectedCredentials = [...(expected?.credentialMetadata ?? [])].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (!expected || expected.targetSpaceId !== mappings.spaces?.[system.family_id] || expected.status !== system.status || expected.accessStatus !== access?.status || expected.permissions !== access?.permissions || JSON.stringify(credentials) !== JSON.stringify(expectedCredentials)) {
      fail("systems:fields");
    }
  }
}

if (mismatches.size) {
  const summary = Object.fromEntries([...mismatches.entries()].sort(([a], [b]) => a.localeCompare(b)));
  console.error(JSON.stringify({ ok: false, semanticDrift: summary }));
  process.exit(2);
}

console.log(JSON.stringify({
  ok: true,
  semanticDrift: false,
  verified: {
    users: data.users?.length ?? 0,
    spaces: data.families?.length ?? 0,
    memberships: data.familyMembers?.length ?? 0,
    events: data.events?.length ?? 0,
    tasks: data.tasks?.length ?? 0,
    dayRecords: data.dayRecords?.length ?? 0,
    wishes: data.wishes?.length ?? 0,
    objects: sourceAvatarRows.length,
    systems: systems.length,
  },
}));

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE_SCHEMA_VERSION = "11";
const SNAPSHOT_FORMAT_VERSION = 1;
const REPORT_FORMAT_VERSION = 1;
const TARGET = Object.freeze({
  identityContract: "0.4.0",
  identitySchema: "4",
  coreContract: "0.12.0",
  coreSchema: "24",
  modelContract: "mct_9a3d9588da8591ab376ef000e5e661f670a64dd8b1ebc14fd146580f0ed1fa45",
});
const USER_SCOPES = [
  "profile:read",
  "profile:write",
  "spaces:read",
  "spaces:write",
  "spaces:manage",
  "resources:read",
  "resources:write",
];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const DEFAULT_SNAPSHOT = ".migration/homemew-snapshot.json";
const DEFAULT_REPORT = ".migration/migration-report.json";

class MigrationError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "MigrationError";
    this.details = details;
  }
}

class ApiCallError extends MigrationError {
  constructor(service, method, path, status, code, message, requestId) {
    super(`${service} ${method} ${path} failed: ${status} ${code ?? "HTTP_ERROR"}: ${message ?? "request failed"}`);
    this.name = "ApiCallError";
    this.service = service;
    this.status = status;
    this.code = code ?? null;
    this.requestId = requestId ?? null;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function checksumSnapshot(snapshot) {
  const copy = structuredClone(snapshot);
  if (copy.source) delete copy.source.snapshotChecksum;
  return sha256(stableStringify(copy));
}

function cliValue(name, fallback = undefined) {
  const args = process.argv.slice(3);
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new MigrationError(`${name} requires a value`);
  return value;
}

function requiredEnv(name, fallbackName = undefined) {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  if (!value?.trim()) throw new MigrationError(`Environment variable ${name}${fallbackName ? ` (or ${fallbackName})` : ""} is required`);
  return value.trim();
}

async function writeJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  return absolute;
}

function array(value, name) {
  if (!Array.isArray(value)) throw new MigrationError(`Snapshot ${name} must be an array`);
  return value;
}

function mapBy(rows, key, label) {
  const result = new Map();
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "string" || !value) throw new MigrationError(`${label} has an invalid ${key}`);
    if (result.has(value)) throw new MigrationError(`${label} contains duplicate ${key} ${value}`);
    result.set(value, row);
  }
  return result;
}

function groupBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = row[key];
    const items = result.get(value) ?? [];
    items.push(row);
    result.set(value, items);
  }
  return result;
}

function sameStringArray(left, right) {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function sanitizeError(error) {
  if (error instanceof ApiCallError) {
    return { name: error.name, message: error.message, service: error.service, status: error.status, code: error.code, requestId: error.requestId };
  }
  if (error instanceof MigrationError) return { name: error.name, message: error.message, details: error.details ?? null };
  return { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) };
}

function assertNonProductionUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MigrationError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new MigrationError(`${label} must use HTTPS outside local development`);
  }
  if (["auth.aisr.online", "core.aisr.online"].includes(url.hostname.toLowerCase())) {
    throw new MigrationError(`Phase 5 refuses production target ${url.hostname}`);
  }
  return url.toString().replace(/\/$/, "");
}

async function cloudflareD1Batch(entries) {
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID");
  const databaseId = requiredEnv("HOMEMEW_D1_DATABASE_ID");
  const token = requiredEnv("HOMEMEW_D1_API_TOKEN", "CLOUDFLARE_API_TOKEN");
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ batch: entries.map(({ sql }) => ({ sql })) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.success === false || !Array.isArray(payload.result)) {
    const message = payload?.errors?.map((item) => item.message).filter(Boolean).join("; ") || response.statusText || "D1 query failed";
    throw new MigrationError(`HomeMew D1 read failed: ${response.status} ${message}`);
  }
  if (payload.result.length !== entries.length) throw new MigrationError("HomeMew D1 batch returned an unexpected result count");
  const output = {};
  for (let index = 0; index < entries.length; index += 1) {
    const result = payload.result[index];
    if (result?.success !== true || !Array.isArray(result.results)) {
      throw new MigrationError(`HomeMew D1 query ${entries[index].name} failed`);
    }
    output[entries[index].name] = result.results;
  }
  return { databaseId, output };
}

async function captureSnapshot(outPath) {
  const queries = [
    { name: "schema", sql: "SELECT value FROM schema_metadata WHERE key='schema_version'" },
    { name: "users", sql: "SELECT id,display_name,status,created_from,avatar_key FROM users WHERE status='active' ORDER BY id" },
    { name: "families", sql: "SELECT id,name,created_by,status,timezone,avatar_key FROM families WHERE status='active' ORDER BY id" },
    { name: "familyMembers", sql: "SELECT id,family_id,user_id,role,status,joined_at FROM family_members WHERE status='active' ORDER BY family_id,user_id" },
    { name: "events", sql: "SELECT id,family_id,summary,description,start_at,end_at,start_date,end_date,is_all_day,start_timezone,end_timezone,location,status FROM events WHERE deleted_at IS NULL ORDER BY id" },
    { name: "eventAttendees", sql: "SELECT ea.event_id,ea.user_id FROM event_attendees ea JOIN events e ON e.id=ea.event_id WHERE e.deleted_at IS NULL ORDER BY ea.event_id,ea.user_id" },
    { name: "tasks", sql: "SELECT id,family_id,name,description,due_date,status,completed_at,completed_by_type,completed_by_id FROM tasks WHERE deleted_at IS NULL ORDER BY id" },
    { name: "taskAssignees", sql: "SELECT ta.task_id,ta.user_id FROM task_assignees ta JOIN tasks t ON t.id=ta.task_id WHERE t.deleted_at IS NULL ORDER BY ta.task_id,ta.user_id" },
    { name: "dayRecords", sql: "SELECT id,family_id,name,description,kind,anchor_date,cycle_days,next_due_date,attention_before_days,attention_after_days,subject_user_id,icon,status FROM day_records WHERE deleted_at IS NULL ORDER BY id" },
    { name: "dayRecordOccurrences", sql: "SELECT o.id,o.day_record_id,o.occurred_on,o.note,o.source,o.recorded_by_type,o.recorded_by_id FROM day_record_occurrences o JOIN day_records d ON d.id=o.day_record_id WHERE d.deleted_at IS NULL ORDER BY o.day_record_id,o.occurred_on,o.id" },
    { name: "wishes", sql: "SELECT id,family_id,owner_user_id,title,description,desired_date,status,claimant_user_id,claimed_at,fulfilled_by_user_id,fulfilled_at,archived_from_status FROM wishes WHERE deleted_at IS NULL ORDER BY id" },
    { name: "systems", sql: "SELECT id,family_id,name,description,status FROM system_identities WHERE status!='deleted' ORDER BY id" },
    { name: "systemAccess", sql: "SELECT family_id,system_id,status,permissions FROM family_system_access ORDER BY family_id,system_id" },
    { name: "systemCredentials", sql: "SELECT system_id,credential_type,status,expires_at,COUNT(*) credential_count FROM system_credentials GROUP BY system_id,credential_type,status,expires_at ORDER BY system_id,credential_type,status,expires_at" },
    { name: "omissions", sql: `SELECT
      (SELECT COUNT(*) FROM users WHERE status!='active') disabled_users,
      (SELECT COUNT(*) FROM families WHERE status!='active') archived_families,
      (SELECT COUNT(*) FROM family_members WHERE status!='active') removed_memberships,
      (SELECT COUNT(*) FROM family_invites) family_invites,
      (SELECT COUNT(*) FROM family_invite_redemptions) invite_redemptions,
      (SELECT COUNT(*) FROM events WHERE deleted_at IS NOT NULL) deleted_events,
      (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NOT NULL) deleted_tasks,
      (SELECT COUNT(*) FROM day_records WHERE deleted_at IS NOT NULL) deleted_day_records,
      (SELECT COUNT(*) FROM wishes WHERE deleted_at IS NOT NULL) deleted_wishes,
      (SELECT COUNT(*) FROM oauth_rate_limits) oauth_rate_limits,
      (SELECT COUNT(*) FROM oauth_access_tokens) oauth_access_tokens,
      (SELECT COUNT(*) FROM creation_draft_jobs) creation_draft_jobs` },
  ];
  const { databaseId, output } = await cloudflareD1Batch(queries);
  const schemaVersion = String(output.schema[0]?.value ?? "");
  if (schemaVersion !== SOURCE_SCHEMA_VERSION) {
    throw new MigrationError(`Unsupported HomeMew schema ${schemaVersion || "missing"}; expected ${SOURCE_SCHEMA_VERSION}`);
  }
  const snapshot = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    capturedAt: new Date().toISOString(),
    source: {
      schemaVersion,
      databaseId,
      assetsPublicUrl: process.env.HOMEMEW_ASSETS_PUBLIC_URL?.trim() || null,
      snapshotChecksum: null,
    },
    data: {
      users: output.users,
      families: output.families,
      familyMembers: output.familyMembers,
      events: output.events,
      eventAttendees: output.eventAttendees,
      tasks: output.tasks,
      taskAssignees: output.taskAssignees,
      dayRecords: output.dayRecords,
      dayRecordOccurrences: output.dayRecordOccurrences,
      wishes: output.wishes,
      systems: output.systems,
      systemAccess: output.systemAccess,
      systemCredentials: output.systemCredentials,
    },
    omissions: output.omissions[0] ?? {},
  };
  snapshot.source.snapshotChecksum = checksumSnapshot(snapshot);
  const written = await writeJson(outPath, snapshot);
  console.log(`HomeMew read-only snapshot written: ${written}`);
  console.log(`Snapshot checksum: ${snapshot.source.snapshotChecksum}`);
  return snapshot;
}

async function loadSnapshot(path) {
  const value = JSON.parse(await readFile(resolve(path), "utf-8"));
  if (value?.formatVersion !== SNAPSHOT_FORMAT_VERSION) throw new MigrationError(`Unsupported snapshot format ${value?.formatVersion}`);
  if (String(value?.source?.schemaVersion ?? "") !== SOURCE_SCHEMA_VERSION) throw new MigrationError(`Unsupported HomeMew schema ${value?.source?.schemaVersion}`);
  const expected = value?.source?.snapshotChecksum;
  if (typeof expected !== "string" || expected !== checksumSnapshot(value)) throw new MigrationError("Snapshot checksum mismatch");
  return value;
}

function validateSnapshot(snapshot) {
  const data = snapshot.data ?? {};
  const users = array(data.users, "users");
  const families = array(data.families, "families");
  const members = array(data.familyMembers, "familyMembers");
  const events = array(data.events, "events");
  const attendees = array(data.eventAttendees, "eventAttendees");
  const tasks = array(data.tasks, "tasks");
  const assignees = array(data.taskAssignees, "taskAssignees");
  const days = array(data.dayRecords, "dayRecords");
  const occurrences = array(data.dayRecordOccurrences, "dayRecordOccurrences");
  const wishes = array(data.wishes, "wishes");
  const systems = array(data.systems, "systems");
  array(data.systemAccess, "systemAccess");
  array(data.systemCredentials, "systemCredentials");

  const userById = mapBy(users, "id", "users");
  const familyById = mapBy(families, "id", "families");
  const eventById = mapBy(events, "id", "events");
  const taskById = mapBy(tasks, "id", "tasks");
  const dayById = mapBy(days, "id", "dayRecords");
  mapBy(wishes, "id", "wishes");
  mapBy(systems, "id", "systems");
  const membersByFamily = groupBy(members, "family_id");
  const occurrencesByDay = groupBy(occurrences, "day_record_id");

  const membershipKey = new Set();
  for (const member of members) {
    if (!familyById.has(member.family_id)) throw new MigrationError(`Active membership ${member.id} references a non-active family ${member.family_id}`);
    if (!userById.has(member.user_id)) throw new MigrationError(`Active membership ${member.id} references a non-active user ${member.user_id}`);
    const key = `${member.family_id}:${member.user_id}`;
    if (membershipKey.has(key)) throw new MigrationError(`Duplicate active membership ${key}`);
    membershipKey.add(key);
  }
  for (const family of families) {
    if (!userById.has(family.created_by)) throw new MigrationError(`Family ${family.id} creator ${family.created_by} is not an active user`);
    const familyMembers = membersByFamily.get(family.id) ?? [];
    const creatorMember = familyMembers.find((member) => member.user_id === family.created_by);
    if (!creatorMember) throw new MigrationError(`Family ${family.id} creator is not an active family member`);
    if (creatorMember.role !== "admin") throw new MigrationError(`Family ${family.id} creator must be an admin in the frozen HomeMew schema`);
    if (familyMembers.length > 8) throw new MigrationError(`Family ${family.id} has ${familyMembers.length} active members; LifeSpace family limit is 8`);
  }

  const assertMember = (familyId, userId, label) => {
    if (userId === null || userId === undefined) return;
    if (!membershipKey.has(`${familyId}:${userId}`)) throw new MigrationError(`${label} references user ${userId} who is not an active member of family ${familyId}`);
  };
  for (const event of events) {
    if (!familyById.has(event.family_id)) throw new MigrationError(`Event ${event.id} references a non-active family`);
  }
  for (const attendee of attendees) {
    const event = eventById.get(attendee.event_id);
    if (!event) throw new MigrationError(`Attendee references unknown event ${attendee.event_id}`);
    assertMember(event.family_id, attendee.user_id, `Event ${event.id} attendee`);
  }
  for (const task of tasks) {
    if (!familyById.has(task.family_id)) throw new MigrationError(`Task ${task.id} references a non-active family`);
  }
  for (const assignee of assignees) {
    const task = taskById.get(assignee.task_id);
    if (!task) throw new MigrationError(`Assignee references unknown task ${assignee.task_id}`);
    assertMember(task.family_id, assignee.user_id, `Task ${task.id} assignee`);
  }
  for (const day of days) {
    if (!familyById.has(day.family_id)) throw new MigrationError(`Day Record ${day.id} references a non-active family`);
    assertMember(day.family_id, day.subject_user_id, `Day Record ${day.id} subject`);
    const history = [...(occurrencesByDay.get(day.id) ?? [])].sort((left, right) => left.occurred_on.localeCompare(right.occurred_on) || left.id.localeCompare(right.id));
    if (day.kind === "countdown" && history.length) throw new MigrationError(`Countdown Day Record ${day.id} unexpectedly has occurrence history`);
    if (day.kind !== "countdown" && history.length && history.at(-1).occurred_on !== day.anchor_date) {
      throw new MigrationError(`Day Record ${day.id} latest occurrence does not match anchor_date`);
    }
  }
  for (const occurrence of occurrences) {
    if (!dayById.has(occurrence.day_record_id)) throw new MigrationError(`Occurrence ${occurrence.id} references unknown Day Record ${occurrence.day_record_id}`);
  }
  for (const wish of wishes) {
    if (!familyById.has(wish.family_id)) throw new MigrationError(`Wish ${wish.id} references a non-active family`);
    assertMember(wish.family_id, wish.owner_user_id, `Wish ${wish.id} owner`);
    assertMember(wish.family_id, wish.claimant_user_id, `Wish ${wish.id} claimant`);
    assertMember(wish.family_id, wish.fulfilled_by_user_id, `Wish ${wish.id} fulfiller`);
  }
  for (const system of systems) {
    if (!familyById.has(system.family_id)) throw new MigrationError(`System ${system.id} references a non-active family`);
  }
  const hasAvatar = users.some((row) => row.avatar_key) || families.some((row) => row.avatar_key);
  if (hasAvatar && !snapshot.source.assetsPublicUrl) throw new MigrationError("HOMEMEW_ASSETS_PUBLIC_URL was not captured but avatar objects are present");

  return { userById, familyById, eventById, taskById, dayById, membersByFamily, occurrencesByDay };
}

async function apiRequest(service, base, path, { method = "GET", token = undefined, json = undefined, form = undefined } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : form,
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiCallError(service, method, path, response.status, payload?.error?.code, payload?.error?.message, payload?.error?.requestId ?? response.headers.get("x-request-id"));
  }
  if (!payload || !("data" in payload)) throw new MigrationError(`${service} ${method} ${path} returned an invalid response envelope`);
  return payload.data;
}

async function targetStatuses(identityUrl, coreUrl) {
  const identity = await apiRequest("identity", identityUrl, "/api/v1/status");
  const core = await apiRequest("core", coreUrl, "/api/v1/status");
  if (identity.environment !== "staging" || core.environment !== "staging") {
    throw new MigrationError(`Phase 5 requires staging targets; got Identity=${identity.environment}, Core=${core.environment}`);
  }
  if (String(identity.contractVersion) !== TARGET.identityContract || String(identity.schemaVersion) !== TARGET.identitySchema) {
    throw new MigrationError(`Identity target mismatch; expected ${TARGET.identityContract}/schema ${TARGET.identitySchema}`);
  }
  if (String(core.contractVersion) !== TARGET.coreContract || String(core.schemaVersion) !== TARGET.coreSchema) {
    throw new MigrationError(`Core target mismatch; expected ${TARGET.coreContract}/schema ${TARGET.coreSchema}`);
  }
  return { identity, core };
}

function sourceObjectUrl(base, key) {
  const normalized = `${base.replace(/\/$/, "")}/${String(key).replace(/^\/+/, "")}`;
  return new URL(normalized).toString();
}

async function readAvatar(base, key) {
  const response = await fetch(sourceObjectUrl(base, key));
  if (!response.ok) throw new MigrationError(`Source avatar ${key} is not readable: ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(contentType)) throw new MigrationError(`Source avatar ${key} has unsupported content type ${contentType}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_AVATAR_BYTES) throw new MigrationError(`Source avatar ${key} has invalid size ${bytes.byteLength}`);
  return { bytes, contentType, digest: sha256(bytes), filename: String(key).split("/").at(-1) || "avatar" };
}

async function verifyAvatar(url, expected) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new MigrationError(`Target avatar is not readable: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(bytes);
  if (bytes.byteLength !== expected.bytes.byteLength || digest !== expected.digest) {
    throw new MigrationError("Target avatar digest/length does not match source object");
  }
  return { bytes: bytes.byteLength, sha256: digest };
}

async function migrateSnapshot(snapshot, reportPath) {
  const indexes = validateSnapshot(snapshot);
  const identityUrl = assertNonProductionUrl(requiredEnv("LIFESPACE_IDENTITY_URL"), "LIFESPACE_IDENTITY_URL");
  const coreUrl = assertNonProductionUrl(requiredEnv("LIFESPACE_CORE_URL"), "LIFESPACE_CORE_URL");
  const applicationSecret = requiredEnv("LIFESPACE_APPLICATION_SECRET");
  if (!applicationSecret.startsWith("lsa_")) throw new MigrationError("LIFESPACE_APPLICATION_SECRET must be a trusted application credential (lsa_*)");

  const report = {
    formatVersion: REPORT_FORMAT_VERSION,
    startedAt: new Date().toISOString(),
    completedAt: null,
    source: {
      schemaVersion: snapshot.source.schemaVersion,
      snapshotChecksum: snapshot.source.snapshotChecksum,
      capturedAt: snapshot.capturedAt,
    },
    target: {
      identityUrl,
      coreUrl,
      expected: TARGET,
      identityStatus: null,
      coreStatus: null,
      modelContractVerification: "behavioral-through-pinned-model-routes",
    },
    mappings: { users: {}, spaces: {}, memberships: {}, people: {}, events: {}, tasks: {}, dayRecords: {}, wishes: {} },
    migrated: { users: 0, spaces: 0, memberships: 0, people: 0, events: 0, tasks: 0, dayRecords: 0, wishes: 0, objects: 0 },
    omitted: { ...snapshot.omissions },
    credentialReprovisioning: [],
    audit: {
      historicalTimestampsPreserved: false,
      sourceVersionsPreserved: false,
      note: "Phase 5 preserves current business state and relations through native LifeSpace APIs; historical audit timestamps/versions are intentionally not imported.",
      actorSubstitutions: [],
    },
    verification: { users: 0, spaces: 0, memberships: 0, resources: 0, occurrences: 0, objects: [], result: "PENDING" },
    result: "PENDING",
    error: null,
  };

  const runtime = {
    report,
    snapshot,
    indexes,
    identityUrl,
    coreUrl,
    applicationSecret,
    tokens: new Map(),
    people: new Map(),
    familyOwners: new Map(),
    expectedResources: [],
    expectedOccurrences: [],
  };

  const persistFailure = async (error) => {
    report.completedAt = new Date().toISOString();
    report.result = "FAIL";
    report.verification.result = "FAIL";
    report.error = sanitizeError(error);
    await writeJson(reportPath, report);
  };

  try {
    const statuses = await targetStatuses(identityUrl, coreUrl);
    report.target.identityStatus = statuses.identity;
    report.target.coreStatus = statuses.core;
    await migrateUsers(runtime);
    await migrateSpaces(runtime);
    await migrateEvents(runtime);
    await migrateTasks(runtime);
    await migrateDayRecords(runtime);
    await migrateWishes(runtime);
    planCredentialReprovisioning(runtime);
    await verifyMigration(runtime);
    report.completedAt = new Date().toISOString();
    report.result = "PASS";
    report.verification.result = "PASS";
    const written = await writeJson(reportPath, report);
    console.log(`Migration rehearsal PASS. Report written: ${written}`);
    return report;
  } catch (error) {
    await persistFailure(error);
    throw error;
  }
}

async function userToken(runtime, sourceUserId) {
  if (runtime.tokens.has(sourceUserId)) return runtime.tokens.get(sourceUserId);
  const targetUserId = runtime.report.mappings.users[sourceUserId];
  if (!targetUserId) throw new MigrationError(`No target user mapping for ${sourceUserId}`);
  const token = await apiRequest("identity", runtime.identityUrl, "/internal/v1/tokens", {
    method: "POST",
    token: runtime.applicationSecret,
    json: { subjectId: targetUserId, scopes: USER_SCOPES },
  });
  runtime.tokens.set(sourceUserId, token.accessToken);
  return token.accessToken;
}

async function migrateUsers(runtime) {
  for (const user of runtime.snapshot.data.users) {
    const created = await apiRequest("identity", runtime.identityUrl, "/internal/v1/users", {
      method: "POST",
      token: runtime.applicationSecret,
      json: { displayName: user.display_name },
    });
    runtime.report.mappings.users[user.id] = created.id;
    runtime.report.migrated.users += 1;
    const token = await userToken(runtime, user.id);
    const profile = await apiRequest("identity", runtime.identityUrl, "/api/v1/me", { token });
    if (profile.id !== created.id || profile.displayName !== user.display_name) throw new MigrationError(`User verification failed for ${user.id}`);
    runtime.report.verification.users += 1;
    if (user.avatar_key) {
      const source = await readAvatar(runtime.snapshot.source.assetsPublicUrl, user.avatar_key);
      const form = new FormData();
      form.append("file", new Blob([source.bytes], { type: source.contentType }), source.filename);
      const uploaded = await apiRequest("identity", runtime.identityUrl, "/api/v1/me/avatar", { method: "PUT", token, form });
      const verified = await verifyAvatar(uploaded.avatarUrl, source);
      runtime.report.migrated.objects += 1;
      runtime.report.verification.objects.push({ type: "user-avatar", sourceId: user.id, targetId: created.id, ...verified });
    }
  }
}

async function migrateSpaces(runtime) {
  for (const family of runtime.snapshot.data.families) {
    const ownerSourceId = family.created_by;
    runtime.familyOwners.set(family.id, ownerSourceId);
    const ownerToken = await userToken(runtime, ownerSourceId);
    const owner = runtime.indexes.userById.get(ownerSourceId);
    const created = await apiRequest("core", runtime.coreUrl, "/api/v1/spaces", {
      method: "POST",
      token: ownerToken,
      json: { kind: "family", name: family.name, ownerDisplayName: owner.display_name, timezone: family.timezone },
    });
    runtime.report.mappings.spaces[family.id] = created.id;
    runtime.report.migrated.spaces += 1;
    runtime.people.set(`${family.id}:${ownerSourceId}`, created.ownerPersonId);

    const members = runtime.indexes.membersByFamily.get(family.id) ?? [];
    for (const member of members) {
      if (member.user_id === ownerSourceId) continue;
      const targetUserId = runtime.report.mappings.users[member.user_id];
      const sourceUser = runtime.indexes.userById.get(member.user_id);
      const added = await apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(created.id)}/members`, {
        method: "POST",
        token: ownerToken,
        json: { userId: targetUserId, role: member.role === "admin" ? "admin" : "editor", displayName: sourceUser.display_name },
      });
      runtime.people.set(`${family.id}:${member.user_id}`, added.personId);
    }

    const currentMembers = await apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(created.id)}/members`, { token: ownerToken });
    if (currentMembers.length !== members.length) throw new MigrationError(`Space ${created.id} member count mismatch`);
    for (const member of members) {
      const targetUserId = runtime.report.mappings.users[member.user_id];
      const current = currentMembers.find((item) => item.userId === targetUserId);
      if (!current) throw new MigrationError(`Space ${created.id} is missing migrated member ${member.user_id}`);
      const expectedRole = member.user_id === ownerSourceId ? "owner" : member.role === "admin" ? "admin" : "editor";
      if (current.role !== expectedRole) throw new MigrationError(`Space ${created.id} role mismatch for ${member.user_id}`);
      runtime.report.mappings.memberships[member.id] = current.id;
      runtime.report.mappings.people[`${family.id}:${member.user_id}`] = current.personId;
      runtime.people.set(`${family.id}:${member.user_id}`, current.personId);
    }
    runtime.report.migrated.memberships += members.length;
    runtime.report.migrated.people += members.length;
    runtime.report.verification.memberships += members.length;

    if (family.avatar_key) {
      const source = await readAvatar(runtime.snapshot.source.assetsPublicUrl, family.avatar_key);
      const form = new FormData();
      form.append("file", new Blob([source.bytes], { type: source.contentType }), source.filename);
      form.append("version", String(created.version));
      const uploaded = await apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(created.id)}/avatar`, { method: "PUT", token: ownerToken, form });
      const verified = await verifyAvatar(uploaded.avatarUrl, source);
      runtime.report.migrated.objects += 1;
      runtime.report.verification.objects.push({ type: "space-avatar", sourceId: family.id, targetId: created.id, ...verified });
    }
  }
}

function personId(runtime, familyId, sourceUserId) {
  if (sourceUserId === null || sourceUserId === undefined) return null;
  const value = runtime.people.get(`${familyId}:${sourceUserId}`);
  if (!value) throw new MigrationError(`No Space Person mapping for ${familyId}:${sourceUserId}`);
  return value;
}

function familyOwner(runtime, familyId) {
  const value = runtime.familyOwners.get(familyId);
  if (!value) throw new MigrationError(`No family owner mapping for ${familyId}`);
  return value;
}

async function createModel(runtime, sourceFamilyId, route, actorSourceUserId, input) {
  const spaceId = runtime.report.mappings.spaces[sourceFamilyId];
  const token = await userToken(runtime, actorSourceUserId);
  return apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${route}`, { method: "POST", token, json: input });
}

async function modelAction(runtime, sourceFamilyId, route, targetId, action, actorSourceUserId, version, extra = {}) {
  const spaceId = runtime.report.mappings.spaces[sourceFamilyId];
  const token = await userToken(runtime, actorSourceUserId);
  return apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${route}/${encodeURIComponent(targetId)}/actions/${action}`, {
    method: "POST",
    token,
    json: { version, ...extra },
  });
}

async function migrateEvents(runtime) {
  const attendees = groupBy(runtime.snapshot.data.eventAttendees, "event_id");
  for (const event of runtime.snapshot.data.events) {
    const actor = familyOwner(runtime, event.family_id);
    const attendeePersonIds = (attendees.get(event.id) ?? []).map((row) => personId(runtime, event.family_id, row.user_id));
    const created = await createModel(runtime, event.family_id, "events", actor, {
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
    });
    runtime.report.mappings.events[event.id] = created.id;
    runtime.report.migrated.events += 1;
    runtime.expectedResources.push({
      sourceId: event.id, familyId: event.family_id, route: "events", targetId: created.id,
      fields: { summary: event.summary, description: event.description, location: event.location, isAllDay: Boolean(event.is_all_day), startAt: event.start_at, endAt: event.end_at, startTimezone: event.start_timezone, endTimezone: event.end_timezone, startDate: event.start_date, endDateExclusive: event.end_date, attendeePersonIds, status: event.status },
      arrayFields: ["attendeePersonIds"],
    });
  }
}

async function migrateTasks(runtime) {
  const assignees = groupBy(runtime.snapshot.data.taskAssignees, "task_id");
  for (const task of runtime.snapshot.data.tasks) {
    const owner = familyOwner(runtime, task.family_id);
    const assigneePersonIds = (assignees.get(task.id) ?? []).map((row) => personId(runtime, task.family_id, row.user_id));
    let current = await createModel(runtime, task.family_id, "tasks", owner, {
      name: task.name,
      description: task.description,
      dueDate: task.due_date,
      status: task.status === "completed" ? "pending" : task.status,
      assigneePersonIds,
    });
    if (task.status === "completed") {
      let actor = owner;
      if (task.completed_by_type === "user" && runtime.people.has(`${task.family_id}:${task.completed_by_id}`)) actor = task.completed_by_id;
      else runtime.report.audit.actorSubstitutions.push({ type: "task-completion", sourceId: task.id, sourceActorType: task.completed_by_type, sourceActorId: task.completed_by_id, substitutedWithUserId: owner });
      current = await modelAction(runtime, task.family_id, "tasks", current.id, "complete", actor, current.version);
    }
    runtime.report.mappings.tasks[task.id] = current.id;
    runtime.report.migrated.tasks += 1;
    runtime.expectedResources.push({
      sourceId: task.id, familyId: task.family_id, route: "tasks", targetId: current.id,
      fields: { name: task.name, description: task.description, dueDate: task.due_date, status: task.status, assigneePersonIds },
      arrayFields: ["assigneePersonIds"],
    });
  }
}

async function migrateDayRecords(runtime) {
  for (const day of runtime.snapshot.data.dayRecords) {
    const owner = familyOwner(runtime, day.family_id);
    const history = [...(runtime.indexes.occurrencesByDay.get(day.id) ?? [])].sort((left, right) => left.occurred_on.localeCompare(right.occurred_on) || left.id.localeCompare(right.id));
    const initialAnchor = day.kind === "countdown" || history.length === 0 ? day.anchor_date : history[0].occurred_on;
    const input = {
      name: day.name,
      description: day.description,
      kind: day.kind,
      anchorDate: initialAnchor,
      subjectPersonId: personId(runtime, day.family_id, day.subject_user_id),
      icon: day.icon,
    };
    if (day.kind === "elapsed") input.attentionAfterDays = day.attention_after_days;
    if (day.kind === "countdown") input.attentionBeforeDays = day.attention_before_days;
    if (day.kind === "cycle") {
      input.cycleDays = day.cycle_days;
      input.attentionBeforeDays = day.attention_before_days;
    }
    let current = await createModel(runtime, day.family_id, "day-records", owner, input);
    const expectedDates = [];
    if (day.kind !== "countdown") {
      expectedDates.push(initialAnchor);
      for (const occurrence of history.filter((item) => item.occurred_on !== initialAnchor)) {
        current = await modelAction(runtime, day.family_id, "day-records", current.id, "record-occurrence", owner, current.version, { occurredOn: occurrence.occurred_on, note: occurrence.note });
        expectedDates.push(occurrence.occurred_on);
      }
      if (current.anchorDate !== day.anchor_date) throw new MigrationError(`Day Record ${day.id} replay did not reach source anchor_date`);
    }
    if (day.status === "archived") current = await modelAction(runtime, day.family_id, "day-records", current.id, "archive", owner, current.version);
    runtime.report.mappings.dayRecords[day.id] = current.id;
    runtime.report.migrated.dayRecords += 1;
    runtime.expectedResources.push({
      sourceId: day.id, familyId: day.family_id, route: "day-records", targetId: current.id,
      fields: { name: day.name, description: day.description, kind: day.kind, anchorDate: day.anchor_date, subjectPersonId: personId(runtime, day.family_id, day.subject_user_id), icon: day.icon, attentionAfterDays: day.kind === "elapsed" ? day.attention_after_days : null, attentionBeforeDays: day.kind === "countdown" || day.kind === "cycle" ? day.attention_before_days : null, cycleDays: day.kind === "cycle" ? day.cycle_days : null, status: day.status },
      arrayFields: [],
    });
    runtime.expectedOccurrences.push({ familyId: day.family_id, targetId: current.id, dates: expectedDates });
  }
}

async function migrateWishes(runtime) {
  for (const wish of runtime.snapshot.data.wishes) {
    const owner = wish.owner_user_id;
    let current = await createModel(runtime, wish.family_id, "wishes", owner, {
      title: wish.title,
      description: wish.description,
      desiredDate: wish.desired_date,
      ownerPersonId: personId(runtime, wish.family_id, owner),
      status: "open",
    });

    const originalState = wish.status === "archived" ? wish.archived_from_status : wish.status;
    if (originalState === "claimed" || originalState === "fulfilled") {
      if (wish.claimant_user_id) current = await modelAction(runtime, wish.family_id, "wishes", current.id, "claim", wish.claimant_user_id, current.version);
      else if (originalState === "claimed") throw new MigrationError(`Wish ${wish.id} is claimed without claimant_user_id`);
    }
    if (originalState === "fulfilled") {
      if (!wish.fulfilled_by_user_id) throw new MigrationError(`Wish ${wish.id} is fulfilled without fulfilled_by_user_id`);
      current = await modelAction(runtime, wish.family_id, "wishes", current.id, "fulfill", wish.fulfilled_by_user_id, current.version);
    }
    if (wish.status === "archived") current = await modelAction(runtime, wish.family_id, "wishes", current.id, "archive", owner, current.version);

    runtime.report.mappings.wishes[wish.id] = current.id;
    runtime.report.migrated.wishes += 1;
    runtime.expectedResources.push({
      sourceId: wish.id, familyId: wish.family_id, route: "wishes", targetId: current.id,
      fields: {
        title: wish.title,
        description: wish.description,
        desiredDate: wish.desired_date,
        status: wish.status,
        ownerPersonId: personId(runtime, wish.family_id, wish.owner_user_id),
        claimantPersonId: personId(runtime, wish.family_id, wish.claimant_user_id),
        fulfilledByPersonId: personId(runtime, wish.family_id, wish.fulfilled_by_user_id),
        archivedFromStatus: wish.status === "archived" ? wish.archived_from_status : null,
      },
      arrayFields: [],
    });
  }
}

function planCredentialReprovisioning(runtime) {
  const accessBySystem = new Map(runtime.snapshot.data.systemAccess.map((row) => [row.system_id, row]));
  const credentialsBySystem = groupBy(runtime.snapshot.data.systemCredentials, "system_id");
  for (const system of runtime.snapshot.data.systems) {
    const access = accessBySystem.get(system.id) ?? null;
    runtime.report.credentialReprovisioning.push({
      sourceSystemId: system.id,
      targetSpaceId: runtime.report.mappings.spaces[system.family_id],
      status: system.status,
      accessStatus: access?.status ?? null,
      permissions: access?.permissions ?? null,
      credentialMetadata: (credentialsBySystem.get(system.id) ?? []).map((row) => ({ credentialType: row.credential_type, status: row.status, expiresAt: row.expires_at, count: Number(row.credential_count) })),
      action: "re-provision LifeSpace service principal/Data Grant/credential during cutover; no HomeMew secret is migrated",
    });
  }
}

async function verifyMigration(runtime) {
  for (const family of runtime.snapshot.data.families) {
    const owner = familyOwner(runtime, family.id);
    const ownerToken = await userToken(runtime, owner);
    const spaceId = runtime.report.mappings.spaces[family.id];
    const space = await apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(spaceId)}`, { token: ownerToken });
    if (space.id !== spaceId || space.name !== family.name || space.timezone !== family.timezone) throw new MigrationError(`Space verification failed for ${family.id}`);
    runtime.report.verification.spaces += 1;
  }

  for (const expected of runtime.expectedResources) {
    const token = await userToken(runtime, familyOwner(runtime, expected.familyId));
    const spaceId = runtime.report.mappings.spaces[expected.familyId];
    const current = await apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${expected.route}/${encodeURIComponent(expected.targetId)}`, { token });
    for (const [field, value] of Object.entries(expected.fields)) {
      if (expected.arrayFields.includes(field)) {
        if (!sameStringArray(current[field] ?? [], value ?? [])) throw new MigrationError(`${expected.route} ${expected.sourceId} field ${field} mismatch`);
      } else if ((current[field] ?? null) !== (value ?? null)) {
        throw new MigrationError(`${expected.route} ${expected.sourceId} field ${field} mismatch`, { expected: value ?? null, actual: current[field] ?? null });
      }
    }
    runtime.report.verification.resources += 1;
  }

  for (const expected of runtime.expectedOccurrences) {
    if (!expected.dates.length) continue;
    const token = await userToken(runtime, familyOwner(runtime, expected.familyId));
    const spaceId = runtime.report.mappings.spaces[expected.familyId];
    const result = await apiRequest("core", runtime.coreUrl, `/api/v1/spaces/${encodeURIComponent(spaceId)}/day-records/${encodeURIComponent(expected.targetId)}/occurrences?limit=200`, { token });
    const dates = result.items.map((item) => item.occurredOn);
    if (!sameStringArray(dates, expected.dates)) throw new MigrationError(`Day Record occurrence verification failed for ${expected.targetId}`);
    runtime.report.verification.occurrences += dates.length;
  }

  if (runtime.report.migrated.users !== runtime.snapshot.data.users.length) throw new MigrationError("User count verification failed");
  if (runtime.report.migrated.spaces !== runtime.snapshot.data.families.length) throw new MigrationError("Space count verification failed");
  if (runtime.report.migrated.events !== runtime.snapshot.data.events.length) throw new MigrationError("Event count verification failed");
  if (runtime.report.migrated.tasks !== runtime.snapshot.data.tasks.length) throw new MigrationError("Task count verification failed");
  if (runtime.report.migrated.dayRecords !== runtime.snapshot.data.dayRecords.length) throw new MigrationError("Day Record count verification failed");
  if (runtime.report.migrated.wishes !== runtime.snapshot.data.wishes.length) throw new MigrationError("Wish count verification failed");
}

function usage() {
  console.log(`Usage:\n  node infra/migration/homemew-one-shot.mjs snapshot [--out ${DEFAULT_SNAPSHOT}]\n  node infra/migration/homemew-one-shot.mjs migrate --source ${DEFAULT_SNAPSHOT} [--report ${DEFAULT_REPORT}]\n  node infra/migration/homemew-one-shot.mjs rehearse [--snapshot ${DEFAULT_SNAPSHOT}] [--report ${DEFAULT_REPORT}]\n\nSnapshot env:\n  CLOUDFLARE_ACCOUNT_ID\n  HOMEMEW_D1_DATABASE_ID\n  HOMEMEW_D1_API_TOKEN (or CLOUDFLARE_API_TOKEN)\n  HOMEMEW_ASSETS_PUBLIC_URL (required when avatar_key values exist)\n\nMigration env:\n  LIFESPACE_IDENTITY_URL\n  LIFESPACE_CORE_URL\n  LIFESPACE_APPLICATION_SECRET (server-only lsa_* credential)\n\nPhase 5 refuses any target whose status environment is not staging.`);
}

async function main() {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  if (command === "snapshot") {
    await captureSnapshot(cliValue("--out", DEFAULT_SNAPSHOT));
    return;
  }
  if (command === "migrate") {
    const source = cliValue("--source");
    if (!source) throw new MigrationError("migrate requires --source <snapshot.json>");
    await migrateSnapshot(await loadSnapshot(source), cliValue("--report", DEFAULT_REPORT));
    return;
  }
  if (command === "rehearse") {
    const snapshotPath = cliValue("--snapshot", DEFAULT_SNAPSHOT);
    const snapshot = await captureSnapshot(snapshotPath);
    await migrateSnapshot(snapshot, cliValue("--report", DEFAULT_REPORT));
    return;
  }
  throw new MigrationError(`Unknown command ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify(sanitizeError(error), null, 2));
  process.exitCode = 1;
});

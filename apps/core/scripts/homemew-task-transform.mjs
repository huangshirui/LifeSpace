import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

function fail(message) { throw new Error(`HomeMew task snapshot is invalid: ${message}`); }
function array(value, field) { if (!Array.isArray(value)) fail(`${field} must be an array`); return value; }
function string(value, field) { if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`); return value; }
function instant(value, field) {
  const result = string(value, field);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(`${field} must be an RFC 3339 UTC instant`);
  return new Date(result).toISOString();
}
function date(value, field) {
  if (value === null || value === undefined) return null;
  const result = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(`${field} must be YYYY-MM-DD or null`);
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

export function transformTaskSnapshot(snapshot, familyManifest) {
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
  const tasks = array(snapshot.tasks, "tasks");
  const assignees = array(snapshot.taskAssignees ?? [], "taskAssignees");
  const usersById = unique(users, "users");
  const systemsById = unique(systems, "systemIdentities");
  const tasksById = unique(tasks, "tasks");
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

  function actor(task, prefix, nullable = false) {
    const sourceType = task[`${prefix}ByType`];
    const sourceId = task[`${prefix}ById`];
    if (nullable && sourceType == null && sourceId == null) return null;
    if (sourceType !== "user" && sourceType !== "system") fail(`task ${task.id}.${prefix}ByType is invalid`);
    const id = string(sourceId, `task ${task.id}.${prefix}ById`);
    if (sourceType === "user") {
      const user = usersById.get(id);
      const mappedId = userByLegacyId.get(id);
      if (!user || !mappedId) fail(`task ${task.id}.${prefix}ById has no user mapping`);
      return { type: "user", id: mappedId, name: string(user.displayName, `user ${id}.displayName`) };
    }
    const system = systemsById.get(id);
    return { type: "service", id, name: system ? string(system.name, `system ${id}.name`) : id };
  }

  const taskManifest = [];
  const taskRows = [];
  for (const task of tasks) {
    if (!/^tsk_[A-Za-z0-9]+$/.test(task.id)) fail(`task ${task.id} has an unsupported ID`);
    const spaceId = familyByLegacyId.get(task.familyId);
    if (!spaceId) fail(`task ${task.id} has no family mapping`);
    const name = string(task.name, `task ${task.id}.name`).trim();
    if (name.length > 100) fail(`task ${task.id}.name exceeds 100 characters`);
    if (task.description != null && (typeof task.description !== "string" || task.description.length > 5000)) fail(`task ${task.id}.description is invalid`);
    const dueDate = date(task.dueDate, `task ${task.id}.dueDate`);
    if (!["pending", "completed", "cancelled"].includes(task.status)) fail(`task ${task.id}.status is invalid`);
    if (!Number.isInteger(task.version) || task.version < 1) fail(`task ${task.id}.version is invalid`);
    const createdBy = actor(task, "created");
    const updatedBy = actor(task, "updated");
    const deletedBy = actor(task, "deleted", true);
    const completedBy = actor(task, "completed", true);
    const createdAt = instant(task.createdAt, `task ${task.id}.createdAt`);
    const updatedAt = instant(task.updatedAt, `task ${task.id}.updatedAt`);
    const deletedAt = task.deletedAt == null ? null : instant(task.deletedAt, `task ${task.id}.deletedAt`);
    const completedAt = task.completedAt == null ? null : instant(task.completedAt, `task ${task.id}.completedAt`);
    if ((deletedAt === null) !== (deletedBy === null)) fail(`task ${task.id} deleted actor and timestamp must both be null or present`);
    if (task.status === "completed" && (!completedAt || !completedBy)) fail(`completed task ${task.id} must have completion actor and timestamp`);
    if (task.status !== "completed" && (completedAt || completedBy)) fail(`non-completed task ${task.id} cannot have completion actor or timestamp`);
    taskRows.push({ task, spaceId, name, dueDate, createdBy, updatedBy, deletedBy, completedBy, createdAt, updatedAt, deletedAt, completedAt });
    taskManifest.push({ legacyTaskId: task.id, taskId: task.id });
  }

  const seenAssignees = new Set();
  const assigneeRows = [];
  const hiddenAssignees = [];
  for (const assignee of assignees) {
    const task = tasksById.get(assignee.taskId);
    if (!task) fail(`assignee references missing task ${assignee.taskId}`);
    if (!usersById.has(assignee.userId)) fail(`assignee ${assignee.taskId}/${assignee.userId} references missing user`);
    const member = memberByFamilyUser.get(`${task.familyId}\0${assignee.userId}`);
    if (!member) fail(`assignee ${assignee.taskId}/${assignee.userId} has no family membership`);
    const pair = `${assignee.taskId}\0${assignee.userId}`;
    if (seenAssignees.has(pair)) fail(`duplicate assignee ${assignee.taskId}/${assignee.userId}`);
    seenAssignees.add(pair);
    assigneeRows.push({ taskId: assignee.taskId, personId: membershipByLegacyId.get(member.id), createdAt: instant(assignee.createdAt, `assignee ${pair}.createdAt`) });
    if (member.status === "removed") hiddenAssignees.push({ taskId: assignee.taskId, legacyUserId: assignee.userId });
  }

  const statements = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  for (const row of taskRows) {
    statements.push(`INSERT INTO tasks(
id,space_id,name,description,due_date,status,completed_at,completed_by_type,completed_by_id,completed_by_name_snapshot,
created_by_type,created_by_id,created_by_name_snapshot,updated_by_type,updated_by_id,updated_by_name_snapshot,
version,created_at,updated_at,deleted_at,deleted_by_type,deleted_by_id,mutation_token) VALUES(${[
      row.task.id, row.spaceId, row.name, row.task.description ?? null, row.dueDate, row.task.status, row.completedAt,
      row.completedBy?.type ?? null, row.completedBy?.id ?? null, row.completedBy?.name ?? null,
      row.createdBy.type, row.createdBy.id, row.createdBy.name, row.updatedBy.type, row.updatedBy.id, row.updatedBy.name,
      row.task.version, row.createdAt, row.updatedAt, row.deletedAt, row.deletedBy?.type ?? null, row.deletedBy?.id ?? null, null,
    ].map(sql).join(",")});`);
  }
  for (const row of assigneeRows) statements.push(`INSERT INTO task_assignees(task_id,person_id,created_at) VALUES(${[row.taskId, row.personId, row.createdAt].map(sql).join(",")});`);
  statements.push("COMMIT;");

  const actors = taskRows.flatMap((row) => [row.createdBy, row.updatedBy, row.completedBy, row.deletedBy]).filter(Boolean);
  return {
    coreSql: `${statements.join("\n")}\n`,
    manifest: { version: 1, source: { schemaVersion: "11", exportedAt, commit: source.commit ?? null }, tasks: taskManifest },
    report: {
      status: "ready",
      sourceCounts: { tasks: tasks.length, taskAssignees: assignees.length },
      targetCounts: { tasks: taskRows.length, taskAssignees: assigneeRows.length },
      taskStatuses: {
        pending: taskRows.filter((row) => row.task.status === "pending").length,
        completed: taskRows.filter((row) => row.task.status === "completed").length,
        cancelled: taskRows.filter((row) => row.task.status === "cancelled").length,
        softDeleted: taskRows.filter((row) => row.deletedAt !== null).length,
      },
      assigneesHiddenByRemovedMembership: hiddenAssignees,
      preservedSystemActorIds: [...new Set(actors.filter((actorValue) => actorValue.type === "service").map((actorValue) => actorValue.id))],
    },
  };
}

async function main(argv) {
  const inputIndex = argv.indexOf("--input");
  const manifestIndex = argv.indexOf("--family-manifest");
  const outputIndex = argv.indexOf("--out-dir");
  if (inputIndex < 0 || manifestIndex < 0 || outputIndex < 0 || !argv[inputIndex + 1] || !argv[manifestIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error("Usage: node scripts/homemew-task-transform.mjs --input snapshot.json --family-manifest mapping-manifest.json --out-dir DIR");
  }
  const snapshot = JSON.parse(await readFile(path.resolve(argv[inputIndex + 1]), "utf8"));
  const familyManifest = JSON.parse(await readFile(path.resolve(argv[manifestIndex + 1]), "utf8"));
  const outputDir = path.resolve(argv[outputIndex + 1]);
  const result = transformTaskSnapshot(snapshot, familyManifest);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "core-tasks.sql"), result.coreSql),
    writeFile(path.join(outputDir, "task-mapping-manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "task-migration-report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

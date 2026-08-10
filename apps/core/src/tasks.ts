import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type TaskStatus = "pending" | "completed" | "cancelled";
type TaskSort = "due_asc" | "due_desc" | "created_desc" | "updated_desc";
type TaskRow = {
  id: string;
  space_id: string;
  name: string;
  description: string | null;
  due_date: string | null;
  status: TaskStatus;
  completed_at: string | null;
  completed_by_type: Principal["type"] | null;
  completed_by_id: string | null;
  completed_by_name_snapshot: string | null;
  created_by_type: Principal["type"];
  created_by_id: string;
  created_by_name_snapshot: string;
  updated_by_type: Principal["type"];
  updated_by_id: string;
  updated_by_name_snapshot: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  sort_key?: string | null;
};
type SpaceRow = { id: string };
type LegacyFamilyRow = { legacy_family_id: string; space_id: string };
type Cursor = { v: 1; resource: "tasks"; sort: TaskSort; key: string | null; id: string; filter: string };

const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function body(context: Context<AppEnv>): Promise<Body> {
  let value: unknown;
  try { value = await context.req.json(); } catch { throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be an object", 400);
  return value as Body;
}

function fields(input: Body, allowed: readonly string[]): void {
  const supported = new Set(allowed);
  if (Object.keys(input).some((key) => !supported.has(key))) throw new ApiError("INVALID_REQUEST", "Request contains unsupported task fields", 400);
}

function text(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ApiError("INVALID_REQUEST", `${field} must contain 1-${maxLength} characters`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > maxLength) throw new ApiError("INVALID_REQUEST", `${field} must be a string up to ${maxLength} characters or null`, 400);
  return value.trim() || null;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new ApiError("INVALID_REQUEST", `${field} must be a positive integer`, 400);
  return value as number;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(field === "dueDate" ? "INVALID_DUE_DATE" : "INVALID_REQUEST", `${field} must be YYYY-MM-DD`, 400);
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new ApiError(field === "dueDate" ? "INVALID_DUE_DATE" : "INVALID_REQUEST", `${field} must be a valid date`, 400);
  }
  return value;
}

function dueDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return exactDate(value, "dueDate");
}

function ids(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ApiError("INVALID_REQUEST", `${field} must contain at most ${maxItems} IDs`, 400);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) throw new ApiError("DUPLICATE_ASSIGNEE", `${field} must not contain duplicates`, 400);
  return result;
}

function encodeCursor(value: Cursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(value: string): Cursor {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)))) as Partial<Cursor>;
    if (decoded.v !== 1 || decoded.resource !== "tasks" || !["due_asc", "due_desc", "created_desc", "updated_desc"].includes(decoded.sort ?? "")
      || (decoded.key !== null && typeof decoded.key !== "string") || typeof decoded.id !== "string" || typeof decoded.filter !== "string") throw new Error();
    return decoded as Cursor;
  } catch { throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400); }
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 100;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) throw new ApiError("INVALID_REQUEST", "limit must be an integer between 1 and 200", 400);
  return Number(value);
}

async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {
  const row = await env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL").bind(spaceId).first<SpaceRow>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  return row;
}

async function findFamily(env: Bindings, familyId: string): Promise<LegacyFamilyRow> {
  const row = await env.DB.prepare(`SELECT fm.legacy_family_id,fm.space_id FROM legacy_homemew_family_maps fm
    JOIN spaces s ON s.id=fm.space_id WHERE fm.legacy_family_id=? AND s.kind='family' AND s.deleted_at IS NULL`)
    .bind(familyId).first<LegacyFamilyRow>();
  if (!row) throw new ApiError("FAMILY_NOT_FOUND", "Family not found", 404);
  return row;
}

async function findTask(env: Bindings, spaceId: string, taskId: string): Promise<TaskRow> {
  const row = await env.DB.prepare("SELECT * FROM tasks WHERE id=? AND space_id=? AND deleted_at IS NULL").bind(taskId, spaceId).first<TaskRow>();
  if (!row) throw new ApiError("TASK_NOT_FOUND", "Task not found", 404);
  return row;
}

async function actorName(env: Bindings, spaceId: string, principal: Principal): Promise<string> {
  if (principal.type !== "user") return principal.id;
  const person = await env.DB.prepare(`SELECT display_name FROM space_people
    WHERE space_id=? AND linked_user_id=? ORDER BY deleted_at IS NULL DESC,created_at DESC LIMIT 1`)
    .bind(spaceId, principal.id).first<{ display_name: string }>();
  if (person) return person.display_name;
  const legacy = await env.DB.prepare("SELECT display_name_snapshot FROM legacy_homemew_user_maps WHERE lifespace_user_id=?")
    .bind(principal.id).first<{ display_name_snapshot: string }>();
  return legacy?.display_name_snapshot ?? principal.id;
}

async function requirePeople(env: Bindings, spaceId: string, personIds: string[]): Promise<void> {
  if (!personIds.length) return;
  const placeholders = personIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id FROM space_people WHERE space_id=? AND deleted_at IS NULL AND id IN (${placeholders})`)
    .bind(spaceId, ...personIds).all<{ id: string }>();
  if (rows.results.length !== personIds.length) throw new ApiError("INVALID_ASSIGNEE", "Every assignee must be an active Space Person in the task Space", 400);
}

async function legacyPeople(env: Bindings, familyId: string, legacyUserIds: string[]): Promise<string[]> {
  if (!legacyUserIds.length) return [];
  const placeholders = legacyUserIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT map.legacy_user_id,map.person_id FROM legacy_homemew_membership_maps map
    JOIN space_people p ON p.id=map.person_id AND p.deleted_at IS NULL
    WHERE map.legacy_family_id=? AND map.legacy_user_id IN (${placeholders})`)
    .bind(familyId, ...legacyUserIds).all<{ legacy_user_id: string; person_id: string }>();
  const byUser = new Map(rows.results.map((row) => [row.legacy_user_id, row.person_id]));
  if (byUser.size !== legacyUserIds.length) throw new ApiError("ASSIGNEE_NOT_FAMILY_MEMBER", "Every assignee must be an active family member", 400);
  return legacyUserIds.map((userId) => byUser.get(userId)!);
}

async function actorDto(env: Bindings, type: Principal["type"], id: string, name: string, legacy: boolean) {
  if (!legacy) return { type, id, displayName: name };
  if (type === "user") {
    const mapping = await env.DB.prepare("SELECT legacy_user_id FROM legacy_homemew_user_maps WHERE lifespace_user_id=?")
      .bind(id).first<{ legacy_user_id: string }>();
    return { type: "user", id: mapping?.legacy_user_id ?? id, name, avatarUrl: null };
  }
  return { type: "system", id, name, avatarUrl: null };
}

async function taskDto(env: Bindings, row: TaskRow, legacyFamilyId?: string) {
  const legacy = Boolean(legacyFamilyId);
  const assignees = legacy
    ? await env.DB.prepare(`SELECT map.legacy_user_id user_id,p.display_name FROM task_assignees ta
        JOIN space_people p ON p.id=ta.person_id AND p.deleted_at IS NULL
        JOIN legacy_homemew_membership_maps map ON map.person_id=p.id AND map.legacy_family_id=?
        WHERE ta.task_id=? ORDER BY ta.created_at,p.id`).bind(legacyFamilyId, row.id).all<{ user_id: string; display_name: string }>()
    : await env.DB.prepare(`SELECT p.id person_id,p.display_name FROM task_assignees ta
        JOIN space_people p ON p.id=ta.person_id AND p.deleted_at IS NULL WHERE ta.task_id=? ORDER BY ta.created_at,p.id`)
      .bind(row.id).all<{ person_id: string; display_name: string }>();
  return {
    id: row.id,
    ...(legacy ? { familyId: legacyFamilyId } : { spaceId: row.space_id }),
    name: row.name,
    description: row.description,
    dueDate: row.due_date,
    status: row.status,
    assignees: legacy
      ? (assignees.results as Array<{ user_id: string; display_name: string }>).map((item) => ({ userId: item.user_id, displayName: item.display_name, avatarUrl: null }))
      : (assignees.results as Array<{ person_id: string; display_name: string }>).map((item) => ({ personId: item.person_id, displayName: item.display_name })),
    completedAt: row.completed_at,
    completedBy: row.completed_by_type && row.completed_by_id && row.completed_by_name_snapshot
      ? await actorDto(env, row.completed_by_type, row.completed_by_id, row.completed_by_name_snapshot, legacy) : null,
    createdBy: await actorDto(env, row.created_by_type, row.created_by_id, row.created_by_name_snapshot, legacy),
    updatedBy: await actorDto(env, row.updated_by_type, row.updated_by_id, row.updated_by_name_snapshot, legacy),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createTask(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const input = await body(context);
  const assigneeField = legacyFamilyId ? "assigneeIds" : "assigneePersonIds";
  fields(input, ["name", "description", "dueDate", assigneeField]);
  const name = text(input.name, "name", 100);
  const description = optionalText(input.description, "description", 5000) ?? null;
  const taskDueDate = input.dueDate === undefined ? null : dueDate(input.dueDate);
  const supplied = input[assigneeField] === undefined ? [] : ids(input[assigneeField], assigneeField, legacyFamilyId ? 8 : 100);
  const personIds = legacyFamilyId ? await legacyPeople(context.env, legacyFamilyId, supplied) : supplied;
  if (!legacyFamilyId) await requirePeople(context.env, space.id, personIds);
  const id = createId("tsk");
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  await context.env.DB.batch([
    context.env.DB.prepare(`INSERT INTO tasks(id,space_id,name,description,due_date,created_by_type,created_by_id,created_by_name_snapshot,
      updated_by_type,updated_by_id,updated_by_name_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, space.id, name, description, taskDueDate, principal.type, principal.id, actor, principal.type, principal.id, actor, timestamp, timestamp),
    ...personIds.map((personId) => context.env.DB.prepare("INSERT INTO task_assignees(task_id,person_id,created_at) VALUES(?,?,?)").bind(id, personId, timestamp)),
  ]);
  return context.json(success(await taskDto(context.env, await findTask(context.env, space.id, id), legacyFamilyId)), 201);
}

async function updateTask(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const taskId = context.req.param("taskId")!;
  const previous = await findTask(context.env, space.id, taskId);
  const input = await body(context);
  const assigneeField = legacyFamilyId ? "assigneeIds" : "assigneePersonIds";
  fields(input, ["name", "description", "dueDate", assigneeField, "version"]);
  if (Object.keys(input).length < 2) throw new ApiError("INVALID_REQUEST", "At least one task change is required", 400);
  const expected = positiveInteger(input.version, "version");
  const name = input.name === undefined ? previous.name : text(input.name, "name", 100);
  const description = input.description === undefined ? previous.description : optionalText(input.description, "description", 5000) ?? null;
  const taskDueDate = input.dueDate === undefined ? previous.due_date : dueDate(input.dueDate);
  const supplied = input[assigneeField] === undefined ? undefined : ids(input[assigneeField], assigneeField, legacyFamilyId ? 8 : 100);
  const personIds = supplied === undefined ? undefined : legacyFamilyId ? await legacyPeople(context.env, legacyFamilyId, supplied) : supplied;
  if (personIds && !legacyFamilyId) await requirePeople(context.env, space.id, personIds);
  const mutationToken = crypto.randomUUID();
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const statements = [context.env.DB.prepare(`UPDATE tasks SET name=?,description=?,due_date=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,
    updated_at=?,version=version+1,mutation_token=? WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
    .bind(name, description, taskDueDate, principal.type, principal.id, actor, timestamp, mutationToken, taskId, space.id, expected)];
  if (personIds) {
    statements.push(context.env.DB.prepare("DELETE FROM task_assignees WHERE task_id=? AND EXISTS(SELECT 1 FROM tasks WHERE id=? AND mutation_token=?)").bind(taskId, taskId, mutationToken));
    statements.push(...personIds.map((personId) => context.env.DB.prepare(
      "INSERT INTO task_assignees(task_id,person_id,created_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM tasks WHERE id=? AND mutation_token=?)",
    ).bind(taskId, personId, timestamp, taskId, mutationToken)));
  }
  statements.push(context.env.DB.prepare("UPDATE tasks SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(taskId, mutationToken));
  const results = await context.env.DB.batch(statements);
  if (!results[0].meta.changes) throw new ApiError("TASK_VERSION_CONFLICT", "Task version conflict", 409);
  return context.json(success(await taskDto(context.env, await findTask(context.env, space.id, taskId), legacyFamilyId)));
}

async function deleteTask(context: Context<AppEnv>, space: SpaceRow): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const taskId = context.req.param("taskId")!;
  await findTask(context.env, space.id, taskId);
  const expected = positiveInteger(Number(context.req.query("version")), "version");
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const result = await context.env.DB.prepare(`UPDATE tasks SET deleted_at=?,deleted_by_type=?,deleted_by_id=?,updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,
    updated_at=?,version=version+1 WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
    .bind(timestamp, principal.type, principal.id, principal.type, principal.id, actor, timestamp, taskId, space.id, expected).run();
  if (!result.meta.changes) throw new ApiError("TASK_VERSION_CONFLICT", "Task version conflict", 409);
  return context.body(null, 204);
}

async function actionTask(context: Context<AppEnv>, space: SpaceRow, kind: "complete" | "reopen", legacyFamilyId?: string): Promise<Response> {
  const principal = context.get("principal");
  await requireSpacePermission(context.env, principal, space.id, "write");
  const taskId = context.req.param("taskId")!;
  const row = await findTask(context.env, space.id, taskId);
  const input = await body(context);
  fields(input, ["version"]);
  const expected = positiveInteger(input.version, "version");
  if (kind === "complete" && row.status === "completed") throw new ApiError("TASK_ALREADY_COMPLETED", "Task is already completed", 409);
  if (kind === "reopen" && row.status === "pending") throw new ApiError("TASK_ALREADY_PENDING", "Task is already pending", 409);
  const timestamp = now();
  const actor = await actorName(context.env, space.id, principal);
  const statement = kind === "complete"
    ? context.env.DB.prepare(`UPDATE tasks SET status='completed',completed_at=?,completed_by_type=?,completed_by_id=?,completed_by_name_snapshot=?,
        updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
        WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
      .bind(timestamp, principal.type, principal.id, actor, principal.type, principal.id, actor, timestamp, taskId, space.id, expected)
    : context.env.DB.prepare(`UPDATE tasks SET status='pending',completed_at=NULL,completed_by_type=NULL,completed_by_id=NULL,completed_by_name_snapshot=NULL,
        updated_by_type=?,updated_by_id=?,updated_by_name_snapshot=?,updated_at=?,version=version+1
        WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
      .bind(principal.type, principal.id, actor, timestamp, taskId, space.id, expected);
  const result = await statement.run();
  if (!result.meta.changes) throw new ApiError("TASK_VERSION_CONFLICT", "Task version conflict", 409);
  return context.json(success(await taskDto(context.env, await findTask(context.env, space.id, taskId), legacyFamilyId)));
}

async function assigneeFilter(context: Context<AppEnv>, spaceId: string, legacyFamilyId?: string): Promise<string | undefined> {
  const field = legacyFamilyId ? "assigneeId" : "assigneePersonId";
  let value = context.req.query(field);
  if (!value) return undefined;
  if (value === "me") {
    const principal = context.get("principal");
    if (principal.type !== "user") throw new ApiError("INVALID_FILTER", "me is available only for users", 400);
    if (legacyFamilyId) {
      const mapping = await context.env.DB.prepare(`SELECT person_id FROM legacy_homemew_membership_maps WHERE legacy_family_id=? AND legacy_user_id IN (
        SELECT legacy_user_id FROM legacy_homemew_user_maps WHERE lifespace_user_id=?)`).bind(legacyFamilyId, principal.id).first<{ person_id: string }>();
      if (!mapping) throw new ApiError("ASSIGNEE_NOT_FAMILY_MEMBER", "Current user is not an active family member", 400);
      value = mapping.person_id;
    } else {
      const person = await context.env.DB.prepare("SELECT id FROM space_people WHERE space_id=? AND linked_user_id=? AND deleted_at IS NULL")
        .bind(spaceId, principal.id).first<{ id: string }>();
      if (!person) throw new ApiError("INVALID_ASSIGNEE", "Current user is not an active Space Person", 400);
      value = person.id;
    }
  } else if (legacyFamilyId) value = (await legacyPeople(context.env, legacyFamilyId, [value]))[0];
  else await requirePeople(context.env, spaceId, [value]);
  return value;
}

async function listTasks(context: Context<AppEnv>, space: SpaceRow, legacyFamilyId?: string): Promise<Response> {
  await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
  if (context.req.query("dueFrom") !== undefined || context.req.query("dueTo") !== undefined) throw new ApiError("INVALID_REQUEST", "Use dueDateFrom and dueDateTo", 400);
  const statuses = (context.req.query("status") ?? "pending").split(",") as TaskStatus[];
  if (!statuses.length || new Set(statuses).size !== statuses.length || statuses.some((status) => !["pending", "completed", "cancelled"].includes(status))) {
    throw new ApiError("INVALID_REQUEST", "status is invalid", 400);
  }
  const sort = (context.req.query("sort") ?? "due_asc") as TaskSort;
  if (!["due_asc", "due_desc", "created_desc", "updated_desc"].includes(sort)) throw new ApiError("INVALID_REQUEST", "sort is invalid", 400);
  const dueFrom = context.req.query("dueDateFrom") ? exactDate(context.req.query("dueDateFrom"), "dueDateFrom") : undefined;
  const dueTo = context.req.query("dueDateTo") ? exactDate(context.req.query("dueDateTo"), "dueDateTo") : undefined;
  if (dueFrom && dueTo && dueTo < dueFrom) throw new ApiError("INVALID_REQUEST", "dueDateTo must not precede dueDateFrom", 400);
  const includeNoDueValue = context.req.query("includeNoDue");
  if (includeNoDueValue !== undefined && !["true", "false"].includes(includeNoDueValue)) throw new ApiError("INVALID_REQUEST", "includeNoDue must be true or false", 400);
  // HomeMew runtime currently treats omitted includeNoDue as false despite its OpenAPI declaring true.
  // Keep compatibility behavior stable; native LifeSpace uses the same explicit-query semantics in this slice.
  const includeNoDue = includeNoDueValue === "true";
  const query = context.req.query("q") === undefined ? undefined : text(context.req.query("q"), "q", 100);
  const personId = await assigneeFilter(context, space.id, legacyFamilyId);
  const filter = JSON.stringify({ statuses, dueFrom: dueFrom ?? null, dueTo: dueTo ?? null, includeNoDue, personId: personId ?? null, q: query ?? null });
  const cursor = context.req.query("cursor") ? decodeCursor(context.req.query("cursor")!) : undefined;
  if (cursor && (cursor.filter !== filter || cursor.sort !== sort)) throw new ApiError("INVALID_REQUEST", "cursor is invalid for this query", 400);
  const placeholders = statuses.map(() => "?").join(",");
  const args: unknown[] = [space.id, ...statuses];
  let sql = `SELECT t.* FROM tasks t WHERE t.space_id=? AND t.deleted_at IS NULL AND t.status IN (${placeholders})`;
  if (personId) { sql += " AND EXISTS(SELECT 1 FROM task_assignees ta WHERE ta.task_id=t.id AND ta.person_id=?)"; args.push(personId); }
  if (query) { sql += " AND (instr(lower(t.name),lower(?))>0 OR instr(lower(COALESCE(t.description,'')),lower(?))>0)"; args.push(query, query); }
  if (dueFrom || dueTo) {
    const dated: string[] = [];
    if (dueFrom) { dated.push("t.due_date>=?"); args.push(dueFrom); }
    if (dueTo) { dated.push("t.due_date<=?"); args.push(dueTo); }
    sql += ` AND ((${dated.join(" AND ")})${includeNoDue ? " OR t.due_date IS NULL" : ""})`;
  }
  const keyColumn = sort === "created_desc" ? "t.created_at" : sort === "updated_desc" ? "t.updated_at" : "t.due_date";
  const descending = sort.endsWith("desc");
  if (cursor) {
    if (sort.startsWith("due_")) {
      if (cursor.key === null) { sql += " AND t.due_date IS NULL AND t.id>?"; args.push(cursor.id); }
      else { sql += ` AND ((t.due_date IS NOT NULL AND (${keyColumn}${descending ? "<" : ">"}? OR (${keyColumn}=? AND t.id>?))) OR t.due_date IS NULL)`; args.push(cursor.key, cursor.key, cursor.id); }
    } else { sql += ` AND (${keyColumn}< ? OR (${keyColumn}=? AND t.id>?))`; args.push(cursor.key, cursor.key, cursor.id); }
  }
  sql += sort.startsWith("due_") ? ` ORDER BY t.due_date IS NULL ASC,t.due_date ${descending ? "DESC" : "ASC"},t.id ASC` : ` ORDER BY ${keyColumn} DESC,t.id ASC`;
  const limit = parseLimit(context.req.query("limit"));
  sql += " LIMIT ?"; args.push(limit + 1);
  const rows = await context.env.DB.prepare(sql).bind(...args).all<TaskRow>();
  const page = rows.results.slice(0, limit);
  const items = await Promise.all(page.map((row) => taskDto(context.env, row, legacyFamilyId)));
  const last = page.at(-1);
  const key = last ? (sort === "created_desc" ? last.created_at : sort === "updated_desc" ? last.updated_at : last.due_date) : null;
  const nextCursor = rows.results.length > limit && last ? encodeCursor({ v: 1, resource: "tasks", sort, key, id: last.id, filter }) : null;
  return context.json(success({ items, nextCursor }));
}

export function registerTaskRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/tasks", requireScope("tasks:read"), async (context) => listTasks(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.post("/api/v1/spaces/:spaceId/tasks", requireScope("tasks:write"), async (context) => createTask(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.get("/api/v1/spaces/:spaceId/tasks/:taskId", requireScope("tasks:read"), async (context) => {
    const space = await findSpace(context.env, context.req.param("spaceId"));
    await requireSpacePermission(context.env, context.get("principal"), space.id, "read");
    return context.json(success(await taskDto(context.env, await findTask(context.env, space.id, context.req.param("taskId")))));
  });
  app.patch("/api/v1/spaces/:spaceId/tasks/:taskId", requireScope("tasks:write"), async (context) => updateTask(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.delete("/api/v1/spaces/:spaceId/tasks/:taskId", requireScope("tasks:write"), async (context) => deleteTask(context, await findSpace(context.env, context.req.param("spaceId"))));
  app.post("/api/v1/spaces/:spaceId/tasks/:taskId/complete", requireScope("tasks:write"), async (context) => actionTask(context, await findSpace(context.env, context.req.param("spaceId")), "complete"));
  app.post("/api/v1/spaces/:spaceId/tasks/:taskId/reopen", requireScope("tasks:write"), async (context) => actionTask(context, await findSpace(context.env, context.req.param("spaceId")), "reopen"));

  app.get("/api/v1/families/:familyId/tasks", requireScope("tasks:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return listTasks(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.post("/api/v1/families/:familyId/tasks", requireScope("tasks:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return createTask(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.get("/api/v1/families/:familyId/tasks/:taskId", requireScope("tasks:read"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    await requireSpacePermission(context.env, context.get("principal"), family.space_id, "read");
    return context.json(success(await taskDto(context.env, await findTask(context.env, family.space_id, context.req.param("taskId")), family.legacy_family_id)));
  });
  app.patch("/api/v1/families/:familyId/tasks/:taskId", requireScope("tasks:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return updateTask(context, { id: family.space_id }, family.legacy_family_id);
  });
  app.delete("/api/v1/families/:familyId/tasks/:taskId", requireScope("tasks:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return deleteTask(context, { id: family.space_id });
  });
  app.post("/api/v1/families/:familyId/tasks/:taskId/complete", requireScope("tasks:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return actionTask(context, { id: family.space_id }, "complete", family.legacy_family_id);
  });
  app.post("/api/v1/families/:familyId/tasks/:taskId/reopen", requireScope("tasks:write"), async (context) => {
    const family = await findFamily(context.env, context.req.param("familyId"));
    return actionTask(context, { id: family.space_id }, "reopen", family.legacy_family_id);
  });
}

import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission, type Permission, type SpaceRole } from "./authorization";
import {
  delegationChainStatement,
  groupDelegationChainRows,
  resolveAgentApiDelegatedPrincipal,
  validateStructuralDelegationChain,
  type DelegationChainRow,
} from "./delegation-chain";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type DirectoryAccess = {
  principal: Principal;
  spaceAuthority: SpaceRole | "grant";
  delegationId: string | null;
  delegationChain: string[];
  singleUseDelegationIds: string[];
};
type PersonRow = {
  id: string;
  space_id: string;
  linked_user_id: string | null;
  display_name: string;
  version: number;
  created_at: string;
  updated_at: string;
};
type PersonListRow = PersonRow & { alternate_name: string | null };
type PersonCursor = {
  v: 1;
  spaceId: string;
  q: string | null;
  label: string;
  id: string;
};
type AlternateNameRename = { from: string; to: string };

const MAX_ALTERNATE_NAMES = 20;
const MAX_PAGE_SIZE = 100;
const permissionRank: Record<Permission, number> = { free_busy: 1, read: 2, write: 3, manage: 4 };
const requiredScope: Record<"read" | "write", string> = {
  read: "resources:read",
  write: "resources:write",
};
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  return value as Body;
}

function fields(input: Body, allowed: readonly string[]): void {
  const supported = new Set(allowed);
  if (Object.keys(input).some((key) => !supported.has(key))) {
    throw new ApiError("INVALID_REQUEST", "Request contains unsupported fields", 400);
  }
}

function personName(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ApiError("VALIDATION_ERROR", `${field} must be a string`, 422);
  const normalized = value.trim().normalize("NFC");
  if (!normalized || normalized.length > 100) {
    throw new ApiError("VALIDATION_ERROR", `${field} must contain 1-100 characters`, 422);
  }
  return normalized;
}

function nameKey(value: string): string {
  return value.toLowerCase();
}

function compareNames(left: string, right: string): number {
  const leftKey = nameKey(left);
  const rightKey = nameKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function nameList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ALTERNATE_NAMES) {
    throw new ApiError("VALIDATION_ERROR", `${field} must contain at most ${MAX_ALTERNATE_NAMES} names`, 422);
  }
  const unique = new Map<string, string>();
  for (let index = 0; index < value.length; index += 1) {
    const name = personName(value[index], `${field}[${index}]`);
    const key = nameKey(name);
    if (unique.has(key)) {
      throw new ApiError("VALIDATION_ERROR", `${field} must not contain duplicates`, 422);
    }
    unique.set(key, name);
  }
  return [...unique.values()].sort(compareNames);
}

function alternateNames(value: unknown, displayName: string, field = "alternateNames"): string[] {
  if (value === undefined) return [];
  const names = nameList(value, field);
  const displayKey = nameKey(displayName);
  if (names.some((name) => nameKey(name) === displayKey)) {
    throw new ApiError("VALIDATION_ERROR", `${field} must not duplicate displayName`, 422);
  }
  return names;
}

function renameList(value: unknown): AlternateNameRename[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ALTERNATE_NAMES) {
    throw new ApiError("VALIDATION_ERROR", `alternateNames.rename must contain at most ${MAX_ALTERNATE_NAMES} entries`, 422);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError("VALIDATION_ERROR", `alternateNames.rename[${index}] must be an object`, 422);
    }
    const input = entry as Body;
    fields(input, ["from", "to"]);
    if (!Object.hasOwn(input, "from") || !Object.hasOwn(input, "to")) {
      throw new ApiError("VALIDATION_ERROR", `alternateNames.rename[${index}] requires from and to`, 422);
    }
    return {
      from: personName(input.from, `alternateNames.rename[${index}].from`),
      to: personName(input.to, `alternateNames.rename[${index}].to`),
    };
  });
}

function applyAlternateNamePatch(value: unknown, currentNames: readonly string[], displayName: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("VALIDATION_ERROR", "alternateNames must be an operation object", 422);
  }
  const input = value as Body;
  fields(input, ["set", "add", "remove", "rename"]);
  const hasSet = Object.hasOwn(input, "set");
  const hasIncremental = ["add", "remove", "rename"].some((key) => Object.hasOwn(input, key));
  if (!hasSet && !hasIncremental) {
    throw new ApiError("VALIDATION_ERROR", "alternateNames requires set or at least one incremental operation", 422);
  }
  if (hasSet && hasIncremental) {
    throw new ApiError("VALIDATION_ERROR", "alternateNames.set cannot be combined with add, remove or rename", 422);
  }
  if (hasSet) return alternateNames(input.set, displayName, "alternateNames.set");

  const add = input.add === undefined ? [] : nameList(input.add, "alternateNames.add");
  const remove = input.remove === undefined ? [] : nameList(input.remove, "alternateNames.remove");
  const rename = renameList(input.rename);
  const operationKeys = new Map<string, string>();
  const claim = (name: string, role: string, allowSameRole = false) => {
    const key = nameKey(name);
    const existing = operationKeys.get(key);
    if (existing && !(allowSameRole && existing === role)) {
      throw new ApiError("VALIDATION_ERROR", `alternate name ${name} participates in multiple operations`, 422);
    }
    operationKeys.set(key, role);
  };
  add.forEach((name) => claim(name, "add"));
  remove.forEach((name) => claim(name, "remove"));
  rename.forEach((entry, index) => {
    const fromKey = nameKey(entry.from);
    const toKey = nameKey(entry.to);
    claim(entry.from, `rename[${index}]`);
    claim(entry.to, `rename[${index}]`, fromKey === toKey);
  });

  const next = new Map(currentNames.map((name) => [nameKey(name), name]));
  for (const name of remove) {
    const key = nameKey(name);
    if (!next.has(key)) {
      throw new ApiError("VALIDATION_ERROR", `alternateNames.remove name ${name} is not active`, 422);
    }
    next.delete(key);
  }
  for (const entry of rename) {
    const fromKey = nameKey(entry.from);
    const toKey = nameKey(entry.to);
    if (!next.has(fromKey)) {
      throw new ApiError("VALIDATION_ERROR", `alternateNames.rename source ${entry.from} is not active`, 422);
    }
    if (fromKey !== toKey && next.has(toKey)) {
      throw new ApiError("VALIDATION_ERROR", `alternateNames.rename target ${entry.to} is already active`, 422);
    }
    next.delete(fromKey);
    next.set(toKey, entry.to);
  }
  for (const name of add) {
    const key = nameKey(name);
    if (next.has(key)) {
      throw new ApiError("VALIDATION_ERROR", `alternateNames.add name ${name} is already active`, 422);
    }
    next.set(key, name);
  }

  const names = [...next.values()].sort(compareNames);
  if (names.length > MAX_ALTERNATE_NAMES) {
    throw new ApiError("VALIDATION_ERROR", `alternateNames must contain at most ${MAX_ALTERNATE_NAMES} active names`, 422);
  }
  const displayKey = nameKey(displayName);
  if (names.some((name) => nameKey(name) === displayKey)) {
    throw new ApiError("VALIDATION_ERROR", "alternateNames must not duplicate displayName", 422);
  }
  return names;
}

function version(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ApiError("VALIDATION_ERROR", "version must be a positive integer", 422);
  }
  return value as number;
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ApiError("INVALID_QUERY", `${key} may be supplied only once`, 400);
  return values[0] ?? undefined;
}

function parseLimit(params: URLSearchParams): number {
  const raw = one(params, "limit");
  if (raw === undefined) return 50;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > MAX_PAGE_SIZE) {
    throw new ApiError("INVALID_QUERY", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`, 400);
  }
  return Number(raw);
}

function parseSearch(params: URLSearchParams): string | null {
  const raw = one(params, "q");
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim().normalize("NFC");
  if (value.length > 100) throw new ApiError("INVALID_QUERY", "q must contain at most 100 characters", 400);
  return value;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function encodeCursor(cursor: PersonCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string): PersonCursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<PersonCursor>;
    if (
      value.v !== 1
      || typeof value.spaceId !== "string"
      || (value.q !== null && typeof value.q !== "string")
      || typeof value.label !== "string"
      || typeof value.id !== "string"
    ) throw new Error("invalid cursor");
    return value as PersonCursor;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function delegationHeader(context: Context<AppEnv>): string | null {
  return context.req.header("x-lifespace-delegation-id")?.trim() || null;
}

async function delegationRows(env: Bindings, delegationId: string): Promise<DelegationChainRow[]> {
  const [result] = await env.DB.batch<Record<string, unknown>>([
    delegationChainStatement(env, [delegationId]),
  ]);
  return groupDelegationChainRows((result?.results ?? []) as DelegationChainRow[]).get(delegationId) ?? [];
}

async function requireDirectoryAccess(
  context: Context<AppEnv>,
  spaceId: string,
  required: "read" | "write",
  spacePermission: Permission = required,
): Promise<DirectoryAccess> {
  const authenticated = context.get("principal");
  const selectedDelegationId = delegationHeader(context);
  if (!authenticated.scopes.includes(requiredScope[required])) {
    throw new ApiError("CREDENTIAL_SCOPE_INSUFFICIENT", `Scope ${requiredScope[required]} is required`, 403);
  }

  let principal = authenticated;
  let chain: DelegationChainRow[] = [];
  const agentApiCredential = authenticated.type === "agent"
    && !authenticated.actor
    && authenticated.purpose === "agent_api";

  if (agentApiCredential && selectedDelegationId) {
    const rows = await delegationRows(context.env, selectedDelegationId);
    principal = resolveAgentApiDelegatedPrincipal(authenticated, spaceId, selectedDelegationId, rows);
    chain = validateStructuralDelegationChain(principal, spaceId, selectedDelegationId, rows);
  } else if (authenticated.actor) {
    if (!selectedDelegationId) {
      throw new ApiError("DELEGATION_REQUIRED", "Represented Person Directory execution requires an explicit Delegation selector", 403);
    }
    const rows = await delegationRows(context.env, selectedDelegationId);
    chain = validateStructuralDelegationChain(authenticated, spaceId, selectedDelegationId, rows);
  } else if (selectedDelegationId) {
    throw new ApiError("DELEGATION_INVALID", "Direct Person Directory execution cannot exercise a Delegation", 403);
  }

  if (chain.length) {
    const needed = required === "write" ? permissionRank.write : permissionRank.read;
    for (const row of chain) {
      if (
        row.delegation_target_type !== "space"
        || row.delegation_target_id !== spaceId
        || permissionRank[row.delegation_max_access] < needed
      ) {
        throw new ApiError(
          "DELEGATION_SCOPE_INSUFFICIENT",
          `Delegation chain does not allow ${required} access to the Space Person Directory`,
          403,
        );
      }
    }
  }

  const spaceAuthority = await requireSpacePermission(context.env, principal, spaceId, spacePermission);
  return {
    principal,
    spaceAuthority,
    delegationId: selectedDelegationId,
    delegationChain: chain.map((row) => row.delegation_id),
    singleUseDelegationIds: chain.filter((row) => row.delegation_max_uses === 1).map((row) => row.delegation_id),
  };
}

async function consumeSingleUseRead(env: Bindings, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const consumedAt = now();
  const placeholders = ids.map(() => "?").join(",");
  const expected = ids.length;
  const result = await env.DB.prepare(`UPDATE delegations
    SET consumed_at=?,consumed_by_change_id=NULL
    WHERE id IN (${placeholders})
      AND max_uses=1
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))
      AND (
        SELECT COUNT(*) FROM delegations required
        WHERE required.id IN (${placeholders})
          AND required.max_uses=1
          AND required.consumed_at IS NULL
          AND required.revoked_at IS NULL
          AND (required.expires_at IS NULL OR julianday(required.expires_at)>julianday('now'))
      )=?`)
    .bind(consumedAt, ...ids, ...ids, expected).run();
  if (result.meta.changes !== expected) {
    throw new ApiError("DELEGATION_INVALID", "Single-use Delegation chain was consumed, revoked or expired before the Person read completed", 403);
  }
}

function actor(principal: Principal): { type: string; id: string } {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

function personDto(row: PersonRow, names: readonly string[]) {
  return {
    id: row.id,
    displayName: row.display_name,
    alternateNames: [...names].sort(compareNames),
    linkedUser: row.linked_user_id !== null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findPerson(env: Bindings, spaceId: string, personId: string): Promise<{ row: PersonRow; names: string[] }> {
  const results = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT id,space_id,linked_user_id,display_name,version,created_at,updated_at
      FROM space_people WHERE id=? AND space_id=? AND deleted_at IS NULL`).bind(personId, spaceId),
    env.DB.prepare(`SELECT name FROM space_person_names
      WHERE space_id=? AND person_id=? AND deleted_at IS NULL
      ORDER BY name COLLATE NOCASE,name`).bind(spaceId, personId),
  ]);
  const row = (results[0]?.results?.[0] ?? null) as PersonRow | null;
  if (!row) throw new ApiError("PERSON_NOT_FOUND", "Active Space Person not found", 404);
  const names = (results[1]?.results ?? []).map((entry) => String((entry as { name: string }).name)).sort(compareNames);
  return { row, names };
}

async function listPeople(
  env: Bindings,
  spaceId: string,
  params: URLSearchParams,
): Promise<{ items: ReturnType<typeof personDto>[]; nextCursor: string | null }> {
  for (const key of params.keys()) {
    if (!new Set(["q", "cursor", "limit"]).has(key)) throw new ApiError("INVALID_QUERY", `Unsupported query parameter ${key}`, 400);
  }
  const limit = parseLimit(params);
  const q = parseSearch(params);
  const rawCursor = one(params, "cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (cursor && (cursor.spaceId !== spaceId || cursor.q !== q)) {
    throw new ApiError("INVALID_QUERY", "cursor does not belong to this Person Directory lookup", 400);
  }

  const clauses = ["p.space_id=?", "p.deleted_at IS NULL"];
  const bindings: unknown[] = [spaceId];
  if (q) {
    const pattern = `%${escapeLike(q)}%`;
    clauses.push(`(p.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR p.id IN (
      SELECT n.person_id FROM space_person_names n
      WHERE n.space_id=? AND n.deleted_at IS NULL
        AND n.name LIKE ? ESCAPE '\\' COLLATE NOCASE
    ))`);
    bindings.push(pattern, spaceId, pattern);
  }
  if (cursor) {
    clauses.push("(p.display_name COLLATE NOCASE > ? OR (p.display_name COLLATE NOCASE = ? AND p.id > ?))");
    bindings.push(cursor.label, cursor.label, cursor.id);
  }

  const rows = await env.DB.prepare(`WITH page AS (
      SELECT p.id,p.space_id,p.linked_user_id,p.display_name,p.version,p.created_at,p.updated_at
      FROM space_people p
      WHERE ${clauses.join(" AND ")}
      ORDER BY p.display_name COLLATE NOCASE ASC,p.id ASC
      LIMIT ?
    )
    SELECT page.*,n.name alternate_name
    FROM page
    LEFT JOIN space_person_names n
      ON n.space_id=page.space_id AND n.person_id=page.id AND n.deleted_at IS NULL
    ORDER BY page.display_name COLLATE NOCASE ASC,page.id ASC,n.name COLLATE NOCASE ASC,n.name ASC`)
    .bind(...bindings, limit + 1)
    .all<PersonListRow>();

  const grouped = new Map<string, { row: PersonRow; names: string[] }>();
  for (const row of rows.results) {
    const current = grouped.get(row.id) ?? { row, names: [] };
    if (row.alternate_name !== null) current.names.push(row.alternate_name);
    grouped.set(row.id, current);
  }
  const people = [...grouped.values()];
  const page = people.slice(0, limit);
  const last = page.at(-1)?.row;
  const nextCursor = people.length > limit && last
    ? encodeCursor({ v: 1, spaceId, q, label: last.display_name, id: last.id })
    : null;
  return { items: page.map(({ row, names }) => personDto(row, names)), nextCursor };
}

function namesEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareNames);
  const sortedRight = [...right].sort(compareNames);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function changeStatement(
  env: Bindings,
  changeId: string,
  spaceId: string,
  personId: string,
  operation: "create" | "update" | "delete",
  versionBefore: number | null,
  versionAfter: number,
  access: DirectoryAccess,
  changedFields: readonly string[],
  occurredAt: string,
): D1PreparedStatement {
  const currentActor = actor(access.principal);
  return env.DB.prepare(`INSERT INTO space_person_changes(
      id,person_id,space_id,operation,version_before,version_after,
      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,
      changed_fields_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      changeId,
      personId,
      spaceId,
      operation,
      versionBefore,
      versionAfter,
      access.principal.type,
      access.principal.id,
      currentActor.type,
      currentActor.id,
      access.principal.clientId,
      access.delegationId,
      JSON.stringify(changedFields),
      occurredAt,
    );
}

function delegationEvidenceStatements(
  env: Bindings,
  changeId: string,
  access: DirectoryAccess,
): D1PreparedStatement[] {
  return access.delegationChain.map((delegationId, chainPosition) => env.DB.prepare(
    `INSERT INTO space_person_change_delegations(change_id,delegation_id,chain_position) VALUES(?,?,?)`,
  ).bind(changeId, delegationId, chainPosition));
}

async function assertPersonMutationTarget(
  context: Context<AppEnv>,
  spaceId: string,
  access: DirectoryAccess,
  row: PersonRow,
): Promise<void> {
  if (!row.linked_user_id) {
    await requireSpacePermission(context.env, access.principal, spaceId, "write");
    return;
  }
  if (access.principal.type === "user" && access.principal.id === row.linked_user_id) return;
  if (access.spaceAuthority === "owner" || access.spaceAuthority === "admin") return;
  await requireSpacePermission(context.env, access.principal, spaceId, "manage");
}

export function registerPersonDirectoryRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/people", requireScope("resources:read"), async (context) => {
    const spaceId = context.req.param("spaceId");
    const access = await requireDirectoryAccess(context, spaceId, "read");
    const result = await listPeople(context.env, spaceId, new URL(context.req.url).searchParams);
    await consumeSingleUseRead(context.env, access.singleUseDelegationIds);
    return context.json(success(result));
  });

  app.post("/api/v1/spaces/:spaceId/people", requireScope("resources:write"), async (context) => {
    const spaceId = context.req.param("spaceId");
    const access = await requireDirectoryAccess(context, spaceId, "write");
    const input = await body(context);
    fields(input, ["displayName", "alternateNames"]);
    const displayName = personName(input.displayName, "displayName");
    const names = alternateNames(input.alternateNames, displayName);
    const personId = id("per");
    const changeId = id("pchg");
    const timestamp = now();
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(`INSERT INTO space_people(
        id,space_id,linked_user_id,display_name,created_at,updated_at,version
      ) VALUES(?,?,NULL,?,?,?,1)`).bind(personId, spaceId, displayName, timestamp, timestamp),
      ...names.map((name) => context.env.DB.prepare(`INSERT INTO space_person_names(
        id,space_id,person_id,name,created_at,updated_at
      ) VALUES(?,?,?,?,?,?)`).bind(id("spn"), spaceId, personId, name, timestamp, timestamp)),
      changeStatement(
        context.env,
        changeId,
        spaceId,
        personId,
        "create",
        null,
        1,
        access,
        names.length ? ["displayName", "alternateNames"] : ["displayName"],
        timestamp,
      ),
      ...delegationEvidenceStatements(context.env, changeId, access),
    ];
    await context.env.DB.batch(statements);
    return context.json(success(personDto({
      id: personId,
      space_id: spaceId,
      linked_user_id: null,
      display_name: displayName,
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    }, names)), 201);
  });

  app.get("/api/v1/spaces/:spaceId/people/:personId", requireScope("resources:read"), async (context) => {
    const spaceId = context.req.param("spaceId");
    const access = await requireDirectoryAccess(context, spaceId, "read");
    const person = await findPerson(context.env, spaceId, context.req.param("personId"));
    await consumeSingleUseRead(context.env, access.singleUseDelegationIds);
    return context.json(success(personDto(person.row, person.names)));
  });

  app.patch("/api/v1/spaces/:spaceId/people/:personId", requireScope("resources:write"), async (context) => {
    const spaceId = context.req.param("spaceId");
    const personId = context.req.param("personId");
    // A Person mutation always requires write credential/delegation capability. Space
    // read is enough for the linked user's self-service case; unlinked/other-person
    // mutations are tightened after the target is loaded.
    const access = await requireDirectoryAccess(context, spaceId, "write", "read");
    const current = await findPerson(context.env, spaceId, personId);
    await assertPersonMutationTarget(context, spaceId, access, current.row);
    const input = await body(context);
    fields(input, ["displayName", "alternateNames", "version"]);
    const expected = version(input.version);
    if (input.displayName === undefined && input.alternateNames === undefined) {
      throw new ApiError("INVALID_REQUEST", "At least one Person change is required", 400);
    }
    if (expected !== current.row.version) throw new ApiError("PERSON_VERSION_CONFLICT", "Person version conflict", 409);

    const nextDisplayName = input.displayName === undefined
      ? current.row.display_name
      : personName(input.displayName, "displayName");
    const nextNames = input.alternateNames === undefined
      ? current.names
      : applyAlternateNamePatch(input.alternateNames, current.names, nextDisplayName);
    if (input.alternateNames === undefined && current.names.some((name) => nameKey(name) === nameKey(nextDisplayName))) {
      throw new ApiError("VALIDATION_ERROR", "displayName must not duplicate an alternate name", 422);
    }

    const displayChanged = nextDisplayName !== current.row.display_name;
    const namesChanged = !namesEqual(nextNames, current.names);
    if (!displayChanged && !namesChanged) throw new ApiError("NO_PERSON_CHANGES", "Person update contains no changes", 400);

    const timestamp = now();
    const changeId = id("pchg");
    const changedFields = [
      ...(displayChanged ? ["displayName"] : []),
      ...(namesChanged ? ["alternateNames"] : []),
    ];
    const statements: D1PreparedStatement[] = [
      changeStatement(
        context.env,
        changeId,
        spaceId,
        personId,
        "update",
        expected,
        expected + 1,
        access,
        changedFields,
        timestamp,
      ),
      ...delegationEvidenceStatements(context.env, changeId, access),
      context.env.DB.prepare(`UPDATE space_people
        SET display_name=?,updated_at=?,version=version+1
        WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
        .bind(nextDisplayName, timestamp, personId, spaceId, expected),
    ];

    if (namesChanged) {
      const currentByKey = new Map(current.names.map((name) => [nameKey(name), name]));
      const nextByKey = new Map(nextNames.map((name) => [nameKey(name), name]));
      for (const [key, previousName] of currentByKey) {
        const desired = nextByKey.get(key);
        if (!desired) {
          statements.push(context.env.DB.prepare(`UPDATE space_person_names
            SET deleted_at=?,updated_at=?
            WHERE space_id=? AND person_id=? AND name=? COLLATE NOCASE AND deleted_at IS NULL`)
            .bind(timestamp, timestamp, spaceId, personId, previousName));
        } else if (desired !== previousName) {
          statements.push(context.env.DB.prepare(`UPDATE space_person_names
            SET name=?,updated_at=?
            WHERE space_id=? AND person_id=? AND name=? COLLATE NOCASE AND deleted_at IS NULL`)
            .bind(desired, timestamp, spaceId, personId, previousName));
        }
      }
      for (const [key, desired] of nextByKey) {
        if (currentByKey.has(key)) continue;
        statements.push(context.env.DB.prepare(`INSERT INTO space_person_names(
            id,space_id,person_id,name,created_at,updated_at,deleted_at
          ) VALUES(?,?,?,?,?,?,NULL)
          ON CONFLICT DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,deleted_at=NULL`)
          .bind(id("spn"), spaceId, personId, desired, timestamp, timestamp));
      }
    }

    await context.env.DB.batch(statements);
    return context.json(success(personDto({
      ...current.row,
      display_name: nextDisplayName,
      version: expected + 1,
      updated_at: timestamp,
    }, nextNames)));
  });

  app.delete("/api/v1/spaces/:spaceId/people/:personId", requireScope("resources:write"), async (context) => {
    const spaceId = context.req.param("spaceId");
    const personId = context.req.param("personId");
    const access = await requireDirectoryAccess(context, spaceId, "write");
    const current = await findPerson(context.env, spaceId, personId);
    if (current.row.linked_user_id) {
      throw new ApiError("PERSON_LINKED_USER", "A Person linked to a current User is managed by Membership lifecycle", 409);
    }
    const input = await body(context);
    fields(input, ["version"]);
    const expected = version(input.version);
    if (expected !== current.row.version) throw new ApiError("PERSON_VERSION_CONFLICT", "Person version conflict", 409);

    const timestamp = now();
    const changeId = id("pchg");
    await context.env.DB.batch([
      changeStatement(
        context.env,
        changeId,
        spaceId,
        personId,
        "delete",
        expected,
        expected + 1,
        access,
        ["deletedAt"],
        timestamp,
      ),
      ...delegationEvidenceStatements(context.env, changeId, access),
      context.env.DB.prepare(`UPDATE space_person_names SET deleted_at=?,updated_at=?
        WHERE space_id=? AND person_id=? AND deleted_at IS NULL`).bind(timestamp, timestamp, spaceId, personId),
      context.env.DB.prepare(`UPDATE space_people SET deleted_at=?,updated_at=?,version=version+1
        WHERE id=? AND space_id=? AND deleted_at IS NULL AND version=?`)
        .bind(timestamp, timestamp, personId, spaceId, expected),
    ]);
    return context.body(null, 204);
  });
}

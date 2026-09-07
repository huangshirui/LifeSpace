import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import {
  REFERENCE_RESOLUTION_MAX_IDS,
  relationDiscoveryMetadata,
  type RelationDiscoveryMetadata,
} from "./relation-semantic";

export {
  REFERENCE_RESOLUTION_MAX_IDS,
  REFERENCE_RESOLUTION_PATH,
  RELATION_TARGET_LOOKUP_PATH,
  relationDiscoveryMetadata,
  type RelationDiscoveryMetadata,
} from "./relation-semantic";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type AppContext = Context<AppEnv>;

type PersonTarget = { id: string; label: string };
type ReferenceResolutionItem =
  | { id: string; status: "resolved"; label: string }
  | { id: string; status: "unavailable" };
type PersonCursor = {
  v: 1;
  kind: "person";
  spaceId: string;
  modelKey: string;
  fieldKey: string;
  q: string | null;
  label: string;
  id: string;
};

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
      || value.kind !== "person"
      || typeof value.spaceId !== "string"
      || typeof value.modelKey !== "string"
      || typeof value.fieldKey !== "string"
      || (value.q !== null && typeof value.q !== "string")
      || typeof value.label !== "string"
      || typeof value.id !== "string"
    ) throw new Error("invalid cursor");
    return value as PersonCursor;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ApiError("INVALID_QUERY", `${key} may be supplied only once`, 400);
  return values[0] ?? undefined;
}

function parseLimit(params: URLSearchParams): number {
  const raw = one(params, "limit");
  if (raw === undefined) return 50;
  if (!/^\d+$/u.test(raw) || Number(raw) < 1 || Number(raw) > 100) {
    throw new ApiError("INVALID_QUERY", "limit must be an integer between 1 and 100", 400);
  }
  return Number(raw);
}

function parseSearch(params: URLSearchParams): string | null {
  const raw = one(params, "q");
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  if (value.length > 100) throw new ApiError("INVALID_QUERY", "q must contain at most 100 characters", 400);
  return value;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function validateCursor(
  cursor: PersonCursor,
  spaceId: string,
  modelKey: string,
  fieldKey: string,
  q: string | null,
): void {
  if (
    cursor.spaceId !== spaceId
    || cursor.modelKey !== modelKey
    || cursor.fieldKey !== fieldKey
    || cursor.q !== q
  ) {
    throw new ApiError("INVALID_QUERY", "cursor does not belong to this relation target lookup", 400);
  }
}

async function listPersonTargets(
  env: Bindings,
  spaceId: string,
  modelKey: string,
  fieldKey: string,
  params: URLSearchParams,
): Promise<{ items: PersonTarget[]; nextCursor: string | null }> {
  for (const key of params.keys()) {
    if (!new Set(["q", "cursor", "limit"]).has(key)) throw new ApiError("INVALID_QUERY", `Unsupported query parameter ${key}`, 400);
  }
  const limit = parseLimit(params);
  const q = parseSearch(params);
  const rawCursor = one(params, "cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (cursor) validateCursor(cursor, spaceId, modelKey, fieldKey, q);

  const clauses = ["space_id=?", "deleted_at IS NULL"];
  const bindings: unknown[] = [spaceId];
  if (q) {
    clauses.push("display_name LIKE ? ESCAPE '\\' COLLATE NOCASE");
    bindings.push(`%${escapeLike(q)}%`);
  }
  if (cursor) {
    clauses.push("(display_name COLLATE NOCASE > ? OR (display_name COLLATE NOCASE = ? AND id > ?))");
    bindings.push(cursor.label, cursor.label, cursor.id);
  }

  const rows = await env.DB.prepare(`SELECT id,display_name label
    FROM space_people
    WHERE ${clauses.join(" AND ")}
    ORDER BY display_name COLLATE NOCASE ASC,id ASC
    LIMIT ?`)
    .bind(...bindings, limit + 1)
    .all<PersonTarget>();

  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = rows.results.length > limit && last
    ? encodeCursor({
      v: 1,
      kind: "person",
      spaceId,
      modelKey,
      fieldKey,
      q,
      label: last.label,
      id: last.id,
    })
    : null;
  return { items: page, nextCursor };
}

async function parseReferenceIds(request: Request): Promise<string[]> {
  const body = await request.json<unknown>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "ids")) {
    throw new ApiError("INVALID_REQUEST", "Request body must contain only ids", 400);
  }
  if (!Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > REFERENCE_RESOLUTION_MAX_IDS) {
    throw new ApiError(
      "INVALID_REQUEST",
      `ids must contain 1-${REFERENCE_RESOLUTION_MAX_IDS} reference IDs`,
      400,
    );
  }
  return input.ids.map((value) => {
    if (typeof value !== "string" || value.length > 200 || !/^per_[A-Za-z0-9_-]+$/u.test(value)) {
      throw new ApiError("INVALID_REQUEST", "Person reference IDs must match ^per_ and contain at most 200 characters", 400);
    }
    return value;
  });
}

async function resolvePersonReferences(env: Bindings, spaceId: string, ids: string[]): Promise<ReferenceResolutionItem[]> {
  const uniqueIds = [...new Set(ids)];
  const placeholders = uniqueIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT id,display_name label
    FROM space_people
    WHERE space_id=? AND deleted_at IS NULL AND id IN (${placeholders})`)
    .bind(spaceId, ...uniqueIds)
    .all<PersonTarget>();
  const byId = new Map(rows.results.map((row) => [row.id, row.label]));
  return ids.map((id) => {
    const label = byId.get(id);
    return label === undefined
      ? { id, status: "unavailable" as const }
      : { id, status: "resolved" as const, label };
  });
}

async function authorizeSourceRelation(
  context: AppContext,
  spaceId: string,
  modelKey: string,
  fieldKey: string,
): Promise<{ fieldType: string; relation: RelationDiscoveryMetadata }> {
  const model = modelKey ? await getRuntimeModel(context.env, modelKey) : null;
  if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  const field = fieldKey ? model.definition.fields[fieldKey] : undefined;
  if (!field) throw new ApiError("FIELD_NOT_FOUND", `Field ${fieldKey || "<missing>"} is not declared by model ${model.key}`, 404);
  const relation = relationDiscoveryMetadata(field);
  if (!relation) throw new ApiError("FIELD_NOT_RELATION", `Field ${fieldKey} is not a relation field`, 400);

  const principal = context.get("principal");
  const access = await requireModelAccess(context.env, principal, spaceId, model, "read");
  await requireModelPolicy(context.env, principal, spaceId, model, "read", undefined, undefined, { personId: access.actorPersonId });
  return { fieldType: field.type, relation };
}

export function registerRelationTargetRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/_relation-targets/:modelKey/:fieldKey", async (context) => {
    const spaceId = context.req.param("spaceId");
    const modelKey = context.req.param("modelKey");
    const fieldKey = context.req.param("fieldKey");
    const { fieldType, relation } = await authorizeSourceRelation(context, spaceId, modelKey, fieldKey);

    if (!relation.lookup.supported) {
      throw new ApiError(
        "RELATION_TARGET_LOOKUP_UNSUPPORTED",
        `Relation target lookup for ${fieldType} requires canonical record reference-label semantics`,
        409,
      );
    }

    const result = await listPersonTargets(context.env, spaceId, modelKey, fieldKey, new URL(context.req.url).searchParams);
    return context.json(success(result));
  });

  app.post("/api/v1/spaces/:spaceId/_reference-resolutions/:modelKey/:fieldKey", async (context) => {
    const spaceId = context.req.param("spaceId");
    const modelKey = context.req.param("modelKey");
    const fieldKey = context.req.param("fieldKey");
    const { fieldType, relation } = await authorizeSourceRelation(context, spaceId, modelKey, fieldKey);

    if (!relation.resolution.supported) {
      throw new ApiError(
        "REFERENCE_RESOLUTION_UNSUPPORTED",
        `Reference resolution for ${fieldType} requires canonical record reference-label semantics`,
        409,
      );
    }

    const ids = await parseReferenceIds(context.req.raw);
    return context.json(success({ items: await resolvePersonReferences(context.env, spaceId, ids) }));
  });
}

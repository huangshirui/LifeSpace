import type { Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
type Row = {
  id: string;
  application_id: string;
  space_id: string;
  kind: "agent" | "service" | "event_push" | "external_data";
  name: string;
  note: string | null;
  status: "pending" | "active" | "disabled" | "revoked";
  owner_type: "space" | "user";
  owner_id: string;
  identity_type: "agent" | "service" | null;
  identity_id: string | null;
  created_at: string;
  updated_at: string;
};

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user")
    throw new ApiError("FORBIDDEN", "Only a user may inspect application connections", 403);
}

function page(url: string) {
  const query = new URL(url).searchParams;
  for (const name of query.keys()) {
    if (!["limit", "offset"].includes(name) || query.getAll(name).length !== 1)
      throw new ApiError("INVALID_QUERY", "Invalid Connection list query", 400);
  }
  const parse = (name: "limit" | "offset", fallback: number, maximum: number) => {
    const value = query.get(name);
    if (value === null) return fallback;
    if (!/^(0|[1-9][0-9]{0,5})$/u.test(value))
      throw new ApiError("INVALID_QUERY", "Invalid Connection pagination", 400);
    const number = Number(value);
    if (number > maximum || (name === "limit" && number === 0))
      throw new ApiError("INVALID_QUERY", "Connection pagination out of range", 400);
    return number;
  };
  return { limit: parse("limit", 20, 50), offset: parse("offset", 0, 10000) };
}

function toMetadata(row: Row) {
  return {
    connectionId: row.id,
    applicationId: row.application_id,
    spaceId: row.space_id,
    kind: row.kind,
    name: row.name,
    ...(row.note === null ? {} : { note: row.note }),
    status: row.status,
    owner: { type: row.owner_type, id: row.owner_id },
    ...(row.identity_id && row.identity_type
      ? { identity: { type: row.identity_type, id: row.identity_id } }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Read-only, application-scoped management preview.
 * A separate Account cross-application management contract is required before
 * allowing a generic Account browser token to inspect all Application IDs.
 * Query parameters, headers and Connection IDs never choose the Application.
 */
export function registerUnifiedConnectionReadRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/connections", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const { limit, offset } = page(c.req.url);
    const rows = await c.env.DB.prepare(`SELECT id,application_id,space_id,kind,name,note,status,
      owner_type,owner_id,identity_type,identity_id,created_at,updated_at
      FROM unified_connections WHERE space_id=? AND application_id=?
        AND (owner_type='space' OR (owner_type='user' AND owner_id=?))
      ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`)
      .bind(spaceId, principal.clientId, principal.id, limit + 1, offset).all<Row>();
    const visible = rows.results.slice(0, limit);
    return c.json(success({
      items: visible.map(toMetadata),
      nextOffset: rows.results.length > limit ? offset + limit : null,
    }));
  });

  app.get("/api/v1/spaces/:spaceId/connections/:connectionId", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const connectionId = c.req.param("connectionId");
    if (!/^conn_[A-Za-z0-9_-]{1,123}$/u.test(connectionId))
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    const row = await c.env.DB.prepare(`SELECT id,application_id,space_id,kind,name,note,status,
      owner_type,owner_id,identity_type,identity_id,created_at,updated_at
      FROM unified_connections WHERE id=? AND space_id=? AND application_id=?
        AND (owner_type='space' OR (owner_type='user' AND owner_id=?))`)
      .bind(connectionId, spaceId, principal.clientId, principal.id).first<Row>();
    if (!row) throw new ApiError("NOT_FOUND", "Connection not found", 404);
    return c.json(success(toMetadata(row)));
  });
}

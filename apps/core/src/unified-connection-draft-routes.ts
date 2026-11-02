import type { Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { toMetadata, type UnifiedConnectionRow } from "./unified-connection-read-routes";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
type Kind = "agent" | "service" | "event_push" | "external_data";
const KINDS: Kind[] = ["agent", "service", "event_push", "external_data"];
const ALLOWED_CREATE = ["kind", "name", "note", "ownerType"];
const ALLOWED_UPDATE = ["name", "note", "expectedUpdatedAt"];

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "User principal required", 403);
}

async function body(c: { req: { header(name: string): string | undefined; json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ApiError("INVALID_BODY", "JSON content type required", 415);
  }
  const input = await c.req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ApiError("INVALID_BODY", "Expected JSON object", 400);
  return input as Record<string, unknown>;
}

function allowed(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some(k => !keys.includes(k)))
    throw new ApiError("INVALID_BODY", "Unsupported Connection field", 400);
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 || /[\u0000-\u001F\u007F]/u.test(value))
    throw new ApiError("INVALID_BODY", "Connection name must be 1-120 visible characters", 400);
  return value.trim();
}

function note(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value))
    throw new ApiError("INVALID_BODY", "Invalid Connection note", 400);
  return value;
}

function connectionId(value: string): string {
  if (!/^conn_[A-Za-z0-9_-]{1,123}$/u.test(value))
    throw new ApiError("NOT_FOUND", "Connection not found", 404);
  return value;
}

async function owned(c: { env: Bindings }, principal: Principal, spaceId: string, id: string) {
  const row = await c.env.DB.prepare(`SELECT id,application_id,space_id,kind,name,note,status,
      owner_type,owner_id,identity_type,identity_id,backing_type,backing_id,created_at,updated_at
      FROM unified_connections WHERE id=? AND space_id=? AND application_id=?
      AND (owner_type='space' OR (owner_type='user' AND owner_id=?))`)
    .bind(id, spaceId, principal.clientId, principal.id)
    .first<UnifiedConnectionRow & { backing_type: string | null; backing_id: string | null }>();
  if (!row) throw new ApiError("NOT_FOUND", "Connection not found", 404);
  return row;
}

function laterThan(iso: string): string {
  const old = Date.parse(iso);
  if (!Number.isFinite(old)) throw new ApiError("INVALID_CONNECTION", "Invalid Connection timestamp", 409);
  return new Date(Math.max(Date.now(), old + 1)).toISOString();
}

/**
 * Safe draft lifecycle only. These endpoints do NOT provision identities,
 * issue credentials, activate connections, or revoke live downstream state.
 * A future trusted service flow must implement those transitions atomically
 * with compensating actions across Core and Identity.
 */
export function registerUnifiedConnectionDraftRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/connections", requireScope("spaces:manage"), async c => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");

    const input = await body(c);
    allowed(input, ALLOWED_CREATE);
    if (!KINDS.includes(input.kind as Kind)) throw new ApiError("INVALID_BODY", "Invalid Connection kind", 400);
    const kind = input.kind as Kind;
    const displayName = name(input.name);
    const remark = note(input.note);
    const ownerType = input.ownerType ?? "space";
    if (ownerType !== "user" && ownerType !== "space")
      throw new ApiError("INVALID_BODY", "Invalid Connection owner", 400);
    const ownerId = ownerType === "user" ? principal.id : spaceId;
    const id = "conn_" + crypto.randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    await c.env.DB.prepare(`INSERT INTO unified_connections
      (id,application_id,space_id,kind,name,note,status,owner_type,owner_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending',?,?,?,?)`)
      .bind(id, principal.clientId, spaceId, kind, displayName, remark, ownerType, ownerId, now, now).run();
    return c.json(success({
      connectionId: id,
      applicationId: principal.clientId,
      spaceId,
      kind,
      name: displayName,
      ...(remark === null ? {} : { note: remark }),
      status: "pending" as const,
      owner: { type: ownerType, id: ownerId },
      createdAt: now,
      updatedAt: now,
    }), 201);
  });

  app.patch("/api/v1/spaces/:spaceId/connections/:connectionId", requireScope("spaces:manage"), async c => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const id = connectionId(c.req.param("connectionId"));
    const current = await owned(c, principal, spaceId, id);
    if (current.status === "revoked") throw new ApiError("CONNECTION_REVOKED", "Revoked Connection cannot change", 409);

    const input = await body(c);
    allowed(input, ALLOWED_UPDATE);
    if (!Object.hasOwn(input, "name") && !Object.hasOwn(input, "note"))
      throw new ApiError("INVALID_BODY", "No editable fields provided", 400);
    if (typeof input.expectedUpdatedAt !== "string" || input.expectedUpdatedAt !== current.updated_at)
      throw new ApiError("VERSION_CONFLICT", "Connection was modified", 409);
    const nextName = Object.hasOwn(input, "name") ? name(input.name) : current.name;
    const nextNote = Object.hasOwn(input, "note") ? note(input.note) : current.note;
    const nextTime = laterThan(current.updated_at);
    const updated = await c.env.DB.prepare(`UPDATE unified_connections SET name=?,note=?,updated_at=?
      WHERE id=? AND space_id=? AND application_id=? AND updated_at=? AND status!='revoked'
        AND (owner_type='space' OR (owner_type='user' AND owner_id=?))`)
      .bind(nextName, nextNote, nextTime, id, spaceId, principal.clientId, current.updated_at, principal.id).run();
    if (updated.meta.changes !== 1) throw new ApiError("VERSION_CONFLICT", "Connection changed concurrently", 409);
    return c.json(success(toMetadata({ ...current, name: nextName, note: nextNote, updated_at: nextTime })));
  });

  app.delete("/api/v1/spaces/:spaceId/connections/:connectionId", requireScope("spaces:manage"), async c => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const id = connectionId(c.req.param("connectionId"));
    const current = await owned(c, principal, spaceId, id);
    // This is only draft cancellation: no potentially active principal, token,
    // Endpoint or Provider credential exists to revoke or clean up.
    if (current.status !== "pending" || current.identity_id !== null || current.backing_id !== null)
      throw new ApiError("CONNECTION_NOT_EMPTY", "Provisioned Connection must be revoked through its lifecycle service", 409);
    const at = laterThan(current.updated_at);
    const result = await c.env.DB.prepare(`UPDATE unified_connections
      SET status='revoked',revoked_at=?,updated_at=?
      WHERE id=? AND space_id=? AND application_id=? AND status='pending'
      AND identity_id IS NULL AND backing_id IS NULL AND updated_at=?
      AND (owner_type='space' OR (owner_type='user' AND owner_id=?))`)
      .bind(at, at, id, spaceId, principal.clientId, current.updated_at, principal.id).run();
    if (result.meta.changes !== 1) throw new ApiError("VERSION_CONFLICT", "Connection changed concurrently", 409);
    return new Response(null, { status: 204 });
  });
}

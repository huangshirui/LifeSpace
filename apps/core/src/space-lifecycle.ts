import type { Context, Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { requireScope } from "./auth";
import { ApiError } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type OwnerAuthorityRow = { version: number; role: string | null };

const now = () => new Date().toISOString();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "Only a Space owner user can close a Space", 403);
}

async function body(context: Context<AppEnv>): Promise<Body> {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be an object", 400);
  }
  return value as Body;
}

function expectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ApiError("VALIDATION_ERROR", "version must be a positive integer", 422);
  }
  return value as number;
}

function assertOnlyVersion(input: Body): void {
  if (Object.keys(input).some((key) => key !== "version")) {
    throw new ApiError("INVALID_REQUEST", "Request contains unsupported fields", 400);
  }
}

async function ownerAuthority(env: Bindings, spaceId: string, userId: string): Promise<OwnerAuthorityRow | null> {
  return env.DB.prepare(`SELECT s.version,m.role
    FROM spaces s
    LEFT JOIN space_memberships m
      ON m.space_id=s.id AND m.user_id=? AND m.deleted_at IS NULL
    WHERE s.id=? AND s.deleted_at IS NULL`)
    .bind(userId, spaceId)
    .first<OwnerAuthorityRow>();
}

export function registerSpaceLifecycleRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/close", requireScope("spaces:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);

    const input = await body(c);
    assertOnlyVersion(input);
    const version = expectedVersion(input.version);
    const authority = await ownerAuthority(c.env, spaceId, principal.id);
    if (!authority) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
    if (authority.role !== "owner") {
      throw new ApiError("SPACE_OWNER_REQUIRED", "Only the current Space owner can close the Space", 403);
    }
    if (authority.version !== version) {
      throw new ApiError("SPACE_VERSION_CONFLICT", "Space version conflict", 409);
    }

    const closedAt = now();
    const lifecycleId = createId("slc");
    const closedSpaceExists = `EXISTS (
      SELECT 1 FROM spaces s WHERE s.id=? AND s.deleted_at=? AND s.updated_at=?
    )`;
    const results = await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE spaces
        SET deleted_at=?,updated_at=?,version=version+1
        WHERE id=? AND deleted_at IS NULL AND version=?`)
        .bind(closedAt, closedAt, spaceId, version),
      c.env.DB.prepare(`INSERT INTO space_lifecycle_events(id,space_id,event_type,actor_user_id,occurred_at)
        SELECT ?,?,?,?,? WHERE ${closedSpaceExists}`)
        .bind(lifecycleId, spaceId, "closed", principal.id, closedAt, spaceId, closedAt, closedAt),
      c.env.DB.prepare(`UPDATE space_memberships
        SET deleted_at=?,updated_at=?,version=version+1
        WHERE space_id=? AND deleted_at IS NULL AND ${closedSpaceExists}`)
        .bind(closedAt, closedAt, spaceId, spaceId, closedAt, closedAt),
      c.env.DB.prepare(`UPDATE space_people
        SET deleted_at=?,updated_at=?
        WHERE space_id=? AND deleted_at IS NULL AND ${closedSpaceExists}`)
        .bind(closedAt, closedAt, spaceId, spaceId, closedAt, closedAt),
      c.env.DB.prepare(`UPDATE space_invites
        SET status='revoked',revoked_by_user_id=?,revoked_at=?,updated_at=?
        WHERE space_id=? AND status='active' AND ${closedSpaceExists}`)
        .bind(principal.id, closedAt, closedAt, spaceId, spaceId, closedAt, closedAt),
      c.env.DB.prepare(`UPDATE data_grants
        SET revoked_at=?
        WHERE source_space_id=? AND revoked_at IS NULL AND ${closedSpaceExists}`)
        .bind(closedAt, spaceId, spaceId, closedAt, closedAt),
      c.env.DB.prepare(`UPDATE webhook_endpoints
        SET enabled=0,updated_at=?
        WHERE space_id=? AND deleted_at IS NULL AND enabled=1 AND ${closedSpaceExists}`)
        .bind(closedAt, spaceId, spaceId, closedAt, closedAt),
      c.env.DB.prepare(`UPDATE event_subscriptions
        SET enabled=0,updated_at=?
        WHERE enabled=1 AND deleted_at IS NULL
          AND endpoint_id IN (
            SELECT id FROM webhook_endpoints WHERE space_id=? AND deleted_at IS NULL
          )
          AND ${closedSpaceExists}`)
        .bind(closedAt, spaceId, spaceId, closedAt, closedAt),
    ]);

    if (!results[0].meta.changes) {
      const current = await c.env.DB.prepare("SELECT version,deleted_at FROM spaces WHERE id=?")
        .bind(spaceId).first<{ version: number; deleted_at: string | null }>();
      if (!current || current.deleted_at) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
      throw new ApiError("SPACE_VERSION_CONFLICT", "Space version conflict", 409);
    }

    return c.body(null, 204);
  });
}

import { Hono } from "hono";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireScope } from "./auth";
import { resolveSpaceAuthorityModel } from "./external-model";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
export type Permission = "free_busy" | "read" | "write" | "manage";
export type ResourceType = "space" | "model" | "person_directory";
export type GranteeType = "user" | "space" | "service" | "device" | "agent";
export type GrantRow = {
  id: string;
  source_space_id: string;
  grantee_type: GranteeType;
  grantee_id: string;
  resource_type: ResourceType;
  resource_id: string | null;
  permission: Permission;
  created_by_user_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

export type GrantInput = Record<string, unknown>;

export const grantNow = () => new Date().toISOString();
export const createGrantId = () => `grt_${crypto.randomUUID().replaceAll("-", "")}`;

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "A user principal is required to manage Data Grants", 403);
}

export function grantDto(row: GrantRow) {
  return {
    id: row.id,
    sourceSpaceId: row.source_space_id,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    permission: row.permission,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function parseGrantExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.endsWith("Z") || Number.isNaN(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    throw new ApiError("VALIDATION_ERROR", "expiresAt must be a future RFC 3339 UTC instant or null", 422);
  }
  return value;
}

export function parseGrantPermission(value: unknown): Permission {
  if (!["free_busy", "read", "write", "manage"].includes(value as string)) {
    throw new ApiError("VALIDATION_ERROR", "permission is invalid", 422);
  }
  return value as Permission;
}

export function parseGrantGrantee(input: GrantInput): { granteeType: GranteeType; granteeId: string } {
  if (!["user", "space", "service", "device", "agent"].includes(input.granteeType as string)) {
    throw new ApiError("VALIDATION_ERROR", "granteeType is invalid", 422);
  }
  if (typeof input.granteeId !== "string" || !input.granteeId.trim()) {
    throw new ApiError("VALIDATION_ERROR", "granteeId is required", 422);
  }
  const granteeType = input.granteeType as GranteeType;
  const granteeId = input.granteeId.trim();
  if (granteeType === "agent" && !/^agt_[A-Za-z0-9_-]+$/u.test(granteeId)) {
    throw new ApiError("VALIDATION_ERROR", "Agent granteeId must be a valid agt_* identifier", 422);
  }
  return { granteeType, granteeId };
}

export async function parseGrantResource(env: Bindings, spaceId: string, input: GrantInput): Promise<{ resourceType: ResourceType; resourceId: string | null }> {
  const resourceType = input.resourceType === undefined ? "space" : input.resourceType;
  if (resourceType === "space") {
    if (input.resourceId !== undefined && input.resourceId !== null) {
      throw new ApiError("VALIDATION_ERROR", "resourceId must be null or omitted for a Space-level Data Grant", 422);
    }
    return { resourceType: "space", resourceId: null };
  }
  if (resourceType === "person_directory") {
    if (input.resourceId !== undefined && input.resourceId !== null) {
      throw new ApiError("VALIDATION_ERROR", "resourceId must be null or omitted for a Person Directory Data Grant", 422);
    }
    return { resourceType: "person_directory", resourceId: null };
  }
  if (resourceType !== "model") {
    throw new ApiError("VALIDATION_ERROR", "resourceType must be space, model or person_directory", 422);
  }
  if (typeof input.resourceId !== "string" || !input.resourceId.trim()) {
    throw new ApiError("VALIDATION_ERROR", "resourceId must be a published model key for a model Data Grant", 422);
  }
  const resourceId = input.resourceId.trim();
  if (!await resolveSpaceAuthorityModel(env, spaceId, resourceId)) {
    throw new ApiError("MODEL_NOT_FOUND", `Published model ${resourceId} was not found`, 404);
  }
  return { resourceType: "model", resourceId };
}

export function validateModelPermission(resourceType: ResourceType, permission: Permission): void {
  if (resourceType === "model" && permission === "free_busy") {
    throw new ApiError("VALIDATION_ERROR", "Model Data Grants support read, write or manage permission", 422);
  }
  if (resourceType === "person_directory" && !["read", "write"].includes(permission)) {
    throw new ApiError("VALIDATION_ERROR", "Person Directory Data Grants support read or write permission only", 422);
  }
}

export async function parseGrantBody(request: Request): Promise<GrantInput> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be an object", 400);
  }
  return value as GrantInput;
}

export function registerGrantRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/grants", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const includeRevoked = c.req.query("includeRevoked") === "true";
    const rows = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE source_space_id=?
      ${includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY created_at DESC`).bind(spaceId).all<GrantRow>();
    return c.json(success(rows.results.map(grantDto)));
  });

  app.post("/api/v1/spaces/:spaceId/grants", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const input = await parseGrantBody(c.req.raw);
    const allowedFields = new Set(["granteeType", "granteeId", "resourceType", "resourceId", "permission", "expiresAt"]);
    if (Object.keys(input).some((key) => !allowedFields.has(key))) {
      throw new ApiError("INVALID_REQUEST", "Request contains unsupported fields", 400);
    }
    const grantee = parseGrantGrantee(input);
    const permission = parseGrantPermission(input.permission);
    const resource = await parseGrantResource(c.env, spaceId, input);
    validateModelPermission(resource.resourceType, permission);
    const expiresAt = parseGrantExpiry(input.expiresAt);
    const grantId = createGrantId();
    const createdAt = grantNow();
    await c.env.DB.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      grantId,
      spaceId,
      grantee.granteeType,
      grantee.granteeId,
      resource.resourceType,
      resource.resourceId,
      permission,
      principal.id,
      createdAt,
      expiresAt,
    ).run();
    const row = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=?`).bind(grantId).first<GrantRow>();
    if (!row) throw new Error("Data Grant missing after create");
    return c.json(success(grantDto(row)), 201);
  });

  app.patch("/api/v1/spaces/:spaceId/grants/:grantId", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const current = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=? AND source_space_id=? AND revoked_at IS NULL`).bind(c.req.param("grantId"), spaceId).first<GrantRow>();
    if (!current) throw new ApiError("GRANT_NOT_FOUND", "Active Data Grant not found", 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError("INVALID_REQUEST", "JSON body is required", 400);
    const keys = Object.keys(body);
    if (!keys.length || keys.some((key) => !["permission", "expiresAt"].includes(key))) throw new ApiError("INVALID_REQUEST", "Only permission and expiresAt may be updated", 400);
    const permission = body.permission === undefined ? current.permission : parseGrantPermission(body.permission);
    validateModelPermission(current.resource_type, permission);
    const expiresAt = body.expiresAt === undefined ? current.expires_at : parseGrantExpiry(body.expiresAt);
    await c.env.DB.prepare("UPDATE data_grants SET permission=?,expires_at=? WHERE id=? AND source_space_id=? AND revoked_at IS NULL")
      .bind(permission, expiresAt, current.id, spaceId).run();
    const updated = await c.env.DB.prepare(`SELECT id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at
      FROM data_grants WHERE id=?`).bind(current.id).first<GrantRow>();
    if (!updated) throw new Error("Data Grant missing after update");
    return c.json(success(grantDto(updated)));
  });

  app.delete("/api/v1/spaces/:spaceId/grants/:grantId", requireScope("grants:manage"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "manage");
    const result = await c.env.DB.prepare("UPDATE data_grants SET revoked_at=? WHERE id=? AND source_space_id=? AND revoked_at IS NULL")
      .bind(grantNow(), c.req.param("grantId"), spaceId).run();
    if (!result.meta.changes) throw new ApiError("GRANT_NOT_FOUND", "Active Data Grant not found", 404);
    return c.body(null, 204);
  });
}

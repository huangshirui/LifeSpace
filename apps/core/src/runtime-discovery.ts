import type { Hono } from "hono";
import type { Permission, SpaceRole } from "./authorization";
import { capabilityActionAccess } from "./capability-runtime";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import type { ModelAccess } from "./model-definition";
import { listPublishedModels, type PublishedModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type CatalogRow = { model_key: string; max_access: ModelAccess };
type MembershipRow = { role: SpaceRole };
type GrantRow = { resource_type: "space" | "model"; resource_id: string | null; permission: Permission };

type DiscoveryAction = {
  key: string;
  access: ModelAccess;
  kind: "workflow" | "capability";
};

const accessRank: Record<ModelAccess, number> = { read: 1, write: 2, manage: 3 };
const permissionRank: Record<Permission, number> = { free_busy: 0, read: 1, write: 2, manage: 3 };
const roleRank: Record<SpaceRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 3 };
const scopeForAccess: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};
const accessOrder: ModelAccess[] = ["read", "write", "manage"];

function spaceAuthorityRank(principal: Principal, membership: MembershipRow | null, grants: GrantRow[], modelKey: string): number {
  const membershipLevel = principal.type === "user" && membership ? roleRank[membership.role] : 0;
  const grantLevel = grants.reduce((highest, grant) => {
    const targetsModel = grant.resource_type === "space"
      || (grant.resource_type === "model" && grant.resource_id === modelKey);
    return targetsModel ? Math.max(highest, permissionRank[grant.permission]) : highest;
  }, 0);
  return Math.max(membershipLevel, grantLevel);
}

function effectiveAccess(
  principal: Principal,
  model: PublishedModel,
  catalogAccess: ModelAccess,
  authorityRank: number,
): ModelAccess[] {
  return accessOrder.filter((access) => model.definition.access.includes(access)
    && principal.scopes.includes(scopeForAccess[access])
    && accessRank[catalogAccess] >= accessRank[access]
    && authorityRank >= accessRank[access]);
}

function actions(model: PublishedModel, allowed: ModelAccess[]): DiscoveryAction[] {
  const allowedSet = new Set(allowed);
  const result: DiscoveryAction[] = Object.entries(model.definition.actions ?? {})
    .filter(([, action]) => allowedSet.has(action.access))
    .map(([key, action]) => ({ key, access: action.access, kind: "workflow" as const }));

  if (capabilityActionAccess(model, "record-occurrence") === "write" && allowedSet.has("write")) {
    result.push({ key: "record-occurrence", access: "write", kind: "capability" });
  }

  return result.sort((left, right) => left.key.localeCompare(right.key));
}

function dto(model: PublishedModel, allowed: ModelAccess[]) {
  return {
    key: model.key,
    route: model.route,
    version: model.version,
    schemaHash: model.schemaHash,
    display: model.definition.display,
    description: model.definition.description ?? null,
    access: allowed,
    fields: Object.entries(model.definition.fields).map(([key, field]) => ({ key, ...field })),
    query: {
      searchable: [...(model.definition.query?.searchable ?? [])],
      filterable: [...(model.definition.query?.filterable ?? [])],
      sortable: [...(model.definition.query?.sortable ?? [])],
    },
    actions: actions(model, allowed),
    capabilities: Object.keys(model.definition.capabilities ?? {}).sort(),
  };
}

export function registerRuntimeDiscoveryRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/_discovery", async (context) => {
    const principal = context.get("principal");
    const spaceId = context.req.param("spaceId");

    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(spaceId),
      context.env.DB.prepare(`SELECT model_key,max_access FROM application_model_access
        WHERE application_id=?`).bind(principal.clientId),
    ];

    const membershipIndex = principal.type === "user" ? statements.length : -1;
    if (principal.type === "user") {
      statements.push(context.env.DB.prepare(`SELECT role FROM space_memberships
        WHERE space_id=? AND user_id=? AND deleted_at IS NULL LIMIT 1`).bind(spaceId, principal.id));
    }

    const grantsIndex = statements.length;
    statements.push(context.env.DB.prepare(`SELECT resource_type,resource_id,permission FROM data_grants
      WHERE source_space_id=? AND grantee_type=? AND grantee_id=?
        AND resource_type IN ('space','model')
        AND revoked_at IS NULL AND (expires_at IS NULL OR julianday(expires_at)>julianday('now'))`)
      .bind(spaceId, principal.type, principal.id));

    const results = await context.env.DB.batch(statements);
    const space = (results[0].results ?? [])[0] as { id: string } | undefined;
    if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

    const catalogs = (results[1].results ?? []) as CatalogRow[];
    const catalogByModel = new Map(catalogs.map((row) => [row.model_key, row.max_access]));
    const membership = membershipIndex >= 0
      ? ((results[membershipIndex].results ?? [])[0] as MembershipRow | undefined) ?? null
      : null;
    const grants = (results[grantsIndex].results ?? []) as GrantRow[];
    const models = await listPublishedModels(context.env);

    const visible = models.flatMap((model) => {
      const catalogAccess = catalogByModel.get(model.key);
      if (!catalogAccess) return [];
      const allowed = effectiveAccess(
        principal,
        model,
        catalogAccess,
        spaceAuthorityRank(principal, membership, grants, model.key),
      );
      return allowed.length ? [dto(model, allowed)] : [];
    });

    return context.json(success({ spaceId, models: visible }));
  });
}

import type { Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import type { ModelAccess } from "./model-definition";
import { getRuntimeModel, listPublishedModels, type PublishedModel } from "./model-registry";
import { projectModelSemanticFacts } from "./model-semantic-projection";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type CatalogRow = { model_key: string; max_access: ModelAccess };

const accessRank: Record<ModelAccess, number> = { read: 1, write: 2, manage: 3 };
const accessOrder: ModelAccess[] = ["read", "write", "manage"];
const scopeForAccess: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};
const semanticDetailPathTemplate = "/api/v1/me/_discovery/models/{modelKey}" as const;

function configurationAccess(
  principal: Principal,
  model: PublishedModel,
  catalogAccess: ModelAccess,
): ModelAccess[] {
  return accessOrder.filter((access) => model.definition.access.includes(access)
    && principal.scopes.includes(scopeForAccess[access])
    && accessRank[catalogAccess] >= accessRank[access]);
}

function inventoryModel(model: PublishedModel, access: ModelAccess[]) {
  const semantic = projectModelSemanticFacts(model);
  return {
    key: semantic.key,
    ...(model.definition.origin === "external" ? { origin: "external", fieldsDynamic: true } : {}),
    version: semantic.version,
    schemaHash: semantic.schemaHash,
    display: semantic.display,
    capabilities: semantic.capabilities,
    actions: semantic.actions.map(({ key, access: actionAccess, kind }) => ({
      key,
      access: actionAccess,
      kind,
    })),
    access,
  };
}

async function applicationModelCatalog(env: Bindings, applicationId: string): Promise<Map<string, ModelAccess>> {
  const result = await env.DB.prepare(`SELECT model_key,max_access FROM application_model_access
    WHERE application_id=?`).bind(applicationId).all<CatalogRow>();
  return new Map((result.results ?? []).map((row) => [row.model_key, row.max_access]));
}

function opaqueNotFound(): ApiError {
  return new ApiError("NOT_FOUND", "Resource not found", 404);
}

/**
 * Configuration-time model semantics are deliberately separate from Space data Authority.
 *
 * This Candidate Public Kernel surface answers which published models the authenticated
 * credential/application may configure and what those models mean. It never answers which
 * Space records are readable or writable, and successful projection grants no Space Authority.
 * Runtime execution still rechecks Data Grant/Membership/Delegation and Policy.
 */
export function registerConfigurationModelDiscoveryRoutes(app: App): void {
  app.get("/api/v1/me/_discovery/models", async (context) => {
    const principal = context.get("principal");
    const [catalogByModel, models] = await Promise.all([
      applicationModelCatalog(context.env, principal.clientId),
      listPublishedModels(context.env),
    ]);

    const available = models.flatMap((model) => {
      const catalogAccess = catalogByModel.get(model.key);
      if (!catalogAccess) return [];
      const access = configurationAccess(principal, model, catalogAccess);
      return access.length ? [inventoryModel(model, access)] : [];
    });

    return context.json(success({
      semanticDetailPathTemplate,
      models: available,
    }));
  });

  app.get("/api/v1/me/_discovery/models/:modelKey", async (context) => {
    const principal = context.get("principal");
    const model = await getRuntimeModel(context.env, context.req.param("modelKey"));
    if (!model) throw opaqueNotFound();

    const row = await context.env.DB.prepare(`SELECT model_key,max_access FROM application_model_access
      WHERE application_id=? AND model_key=? LIMIT 1`)
      .bind(principal.clientId, model.key)
      .first<CatalogRow>();
    if (!row) throw opaqueNotFound();

    const access = configurationAccess(principal, model, row.max_access);
    if (!access.length) throw opaqueNotFound();

    return context.json(success({
      access,
      model: projectModelSemanticFacts(model),
    }));
  });
}

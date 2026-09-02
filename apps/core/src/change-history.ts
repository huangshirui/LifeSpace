import type { Hono } from "hono";
import type { ActorType, Bindings, PrincipalType, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type ResourceRow = { model_key: string };
type ChangeRow = {
  id: string;
  record_id: string;
  space_id: string;
  model_key: string;
  operation: "create" | "update" | "action" | "delete";
  version_before: number | null;
  version_after: number;
  principal_type: PrincipalType;
  principal_id: string;
  actor_type: ActorType;
  actor_id: string;
  application_id: string;
  delegation_id: string | null;
  changed_fields_json: string;
  occurred_at: string;
};

function dto(row: ChangeRow) {
  let changedFields: string[] = [];
  try {
    const parsed = JSON.parse(row.changed_fields_json) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) changedFields = parsed;
  } catch {
    changedFields = [];
  }
  return {
    id: row.id,
    recordId: row.record_id,
    spaceId: row.space_id,
    modelKey: row.model_key,
    operation: row.operation,
    versionBefore: row.version_before,
    versionAfter: row.version_after,
    principal: { type: row.principal_type, id: row.principal_id },
    actor: { type: row.actor_type, id: row.actor_id },
    applicationId: row.application_id,
    delegationId: row.delegation_id,
    changedFields,
    occurredAt: row.occurred_at,
  };
}

export function registerChangeHistoryRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/changes/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    const recordId = context.req.param("recordId");
    const resource = await context.env.DB.prepare(`SELECT model_key FROM resource_records
      WHERE id=? AND space_id=? LIMIT 1`).bind(recordId, spaceId).first<ResourceRow>();
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    const model = await getRuntimeModel(context.env, resource.model_key);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
    await requireModelAccess(context.env, context.get("principal"), spaceId, model, "read");

    const rows = await context.env.DB.prepare(`SELECT
        id,record_id,space_id,model_key,operation,version_before,version_after,
        principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,
        changed_fields_json,occurred_at
      FROM resource_changes
      WHERE record_id=? AND space_id=?
      ORDER BY version_after DESC,occurred_at DESC,id DESC
      LIMIT 100`).bind(recordId, spaceId).all<ChangeRow>();
    return context.json(success({ items: rows.results.map(dto) }));
  });
}

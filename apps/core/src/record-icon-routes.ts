import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { changeStatement, appendDelegationChainEvidence, getGenericResource } from "./generic-resource";
import { getRuntimeModel } from "./model-registry";
import { consumeSingleUseRead, requireModelAccess } from "./model-authorization";
import { requireModelPolicy } from "./policy";
import { parseRecordIcon, decodeStoredRecordIcon, RECORD_ICON_FIELD } from "./record-icon";
import { resourceAuditStorageType } from "./resource-audit";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
const ROUTE = "/api/v1/spaces/:spaceId/models/:modelKey/records/:recordId/icon";

export function registerRecordIconRoutes(app: App): void {
  app.patch(ROUTE, async (context: Context<AppEnv>) => {
    const { spaceId, modelKey, recordId } = context.req.param();
    const model = await getRuntimeModel(context.env, modelKey);
    if (!model || model.definition.origin === "external") throw new ApiError("MODEL_NOT_FOUND", "Native model not found", 404);
    const raw = await context.req.json<unknown>().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("INVALID_REQUEST", "Invalid icon mutation", 400);
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "icon,version" || !Number.isInteger(input.version) || Number(input.version) < 1) {
      throw new ApiError("INVALID_REQUEST", "Icon mutation requires icon and positive record version", 400);
    }
    const icon = parseRecordIcon(input.icon);
    const selectedDelegation = context.req.header("x-lifespace-delegation-id")?.trim() || null;
    const decision = await requireModelAccess(context.env, context.get("principal"), spaceId, model, "write", { recordId, delegationId: selectedDelegation });
    const principal = decision.principal;
    const previous = await getGenericResource(context.env, spaceId, model, recordId);
    if (!previous) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, model, "update", previous, {}, decision.policyIdentity);
    if (previous.version !== input.version) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
    // File readiness and same-Space ownership must be checked before the guarded transaction.
    if (icon?.type === "image") {
      const f = await context.env.DB.prepare(`SELECT id FROM files WHERE id=? AND space_id=? AND status='ready'
        AND content_type IN ('image/png','image/jpeg','image/webp') AND size_bytes<=?`)
        .bind(icon.fileId, spaceId, 256 * 1024).first<{ id: string }>();
      if (!f) throw new ApiError("FILE_NOT_FOUND", "Ready Icon file not found in this Space", 404);
      const session = await context.env.DB.prepare(`SELECT id FROM file_upload_sessions
        WHERE file_id=? AND space_id=? AND destination='native' AND model_key=? AND field_key=? AND record_id=? AND status='completed'`)
        .bind(icon.fileId, spaceId, modelKey, RECORD_ICON_FIELD, recordId).first<{ id: string }>();
      if (!session) throw new ApiError("FILE_NOT_FOUND", "File is not an upload for this Record icon", 404);
    }
    const prev = await context.env.DB.prepare(`SELECT icon_json FROM resource_records
      WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL`)
      .bind(recordId, spaceId, modelKey).first<{ icon_json: string | null }>();
    if (!prev) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    const old = decodeStoredRecordIcon(prev.icon_json);
    const timestamp = new Date().toISOString();
    const mutationId = `chg_${crypto.randomUUID().replaceAll("-", "")}`;
    const acting = principal.actor ?? { type: principal.type, id: principal.id };
    const attribution = { delegationId: decision.authority.delegationId, delegationChain: decision.authority.delegationChain };
    const nextVersion = previous.version + 1;
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(`UPDATE resource_records SET icon_json=?,version=?,updated_at=?,mutation_token=?,
        updated_by_type=?,updated_by_entity_type=?,updated_by_id=?,updated_by_name_snapshot=?
        WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL AND version=?`)
        .bind(icon ? JSON.stringify(icon) : null, nextVersion, timestamp, mutationId,
          resourceAuditStorageType(principal.type), principal.type, principal.id, principal.displayName?.trim() || principal.id,
          recordId, spaceId, modelKey, previous.version),
      context.env.DB.prepare(`DELETE FROM resource_file_links
        WHERE source_record_id=? AND field_key=?
        AND EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)
        .bind(recordId, RECORD_ICON_FIELD, recordId, mutationId),
    ];
    if (icon?.type === "image") {
      statements.push(context.env.DB.prepare(`INSERT INTO resource_file_links(
        source_record_id,source_space_id,source_model_key,field_key,ordinal,file_id)
        SELECT ?,?,?,?,?,? WHERE EXISTS(
          SELECT 1 FROM resource_records r JOIN files f ON f.id=?
          WHERE r.id=? AND r.mutation_token=? AND f.space_id=r.space_id AND f.status='ready'
        )`).bind(recordId, spaceId, modelKey, RECORD_ICON_FIELD, 0, icon.fileId,
        icon.fileId, recordId, mutationId));
    }
    statements.push(changeStatement(
      context.env, principal, mutationId, recordId, spaceId, modelKey, "update", null,
      previous.version, nextVersion, ["presentation.icon"],
      [{ field: "presentation.icon", before: { present: true, value: old }, after: { present: true, value: icon } }],
      timestamp, attribution, mutationId,
    ));
    appendDelegationChainEvidence(statements, context.env, mutationId, attribution);
    statements.push(context.env.DB.prepare("UPDATE resource_records SET mutation_token=NULL WHERE id=? AND mutation_token=?").bind(recordId, mutationId));
    const results = await context.env.DB.batch(statements);
    if (!results[0]?.meta.changes) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
    return context.json(success({ id: recordId, version: nextVersion, presentation: { icon } }));
  });
}

import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import {
  boundedString,
  callExternalAdapter,
  externalHash,
  getExternalModel,
  getExternalSource,
  nextExternalRefresh,
  objectInput,
  onlyKeys,
  refreshExternalModel,
  schemaRefreshInterval,
  validateExternalSnapshot,
  type ExternalModelRow,
  type ExternalSource,
} from "./external-model";
import { externalSemanticDetail } from "./external-runtime";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
async function manager(c: Context<AppEnv>) {
  const p = c.get("principal");
  if (p.type !== "user" || p.actor)
    throw new ApiError("FORBIDDEN", "Direct User management is required", 403);
  await requireSpacePermission(c.env, p, c.req.param("spaceId")!, "manage");
}
async function body(c: Context<AppEnv>) {
  return objectInput(await c.req.json<unknown>().catch(() => null));
}
const id = (prefix: string) =>
  prefix + "_" + crypto.randomUUID().replaceAll("-", "");
const now = () => new Date().toISOString();
function sourceDto(s: ExternalSource) {
  return {
    id: s.id,
    spaceId: s.space_id,
    providerKey: s.provider_key,
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}
export function registerExternalModelControlRoutes(app: App) {
  const sourcePath = "/api/v1/spaces/:spaceId/external-sources";
  const modelPath = "/api/v1/spaces/:spaceId/external-models";
  app.use(sourcePath, requireScope("spaces:manage"));
  app.use(sourcePath + "/*", requireScope("spaces:manage"));
  app.use(modelPath, requireScope("spaces:manage"));
  app.use(modelPath + "/*", requireScope("spaces:manage"));
  app.get(sourcePath, async (c) => {
    await manager(c);
    const r = await c.env.DB.prepare(
      "SELECT * FROM external_sources WHERE space_id=? ORDER BY created_at,id",
    )
      .bind(c.req.param("spaceId")!)
      .all<ExternalSource>();
    return c.json(success({ items: r.results.map(sourceDto) }));
  });
  app.post(
    "/api/v1/model-admin/external-sources",
    requireScope("models:manage"),
    async (c) => {
      const principal = c.get("principal");
      if (
        principal.type !== "service" ||
        principal.actor ||
        c.req.header("x-lifespace-actor-token")
      )
        throw new ApiError(
          "FORBIDDEN",
          "Source provisioning requires non-interactive service Model Admin",
          403,
        );
      const input = await body(c);
      onlyKeys(input, ["spaceId", "providerKey", "credentialRef"]);
      const spaceId = boundedString(input.spaceId, "spaceId");
      if (
        !(await c.env.DB.prepare(
          "SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL",
        )
          .bind(spaceId)
          .first())
      )
        throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
      const provider = boundedString(input.providerKey, "providerKey", 32);
      const ref = boundedString(input.credentialRef, "credentialRef", 128);
      if (
        !/^[a-z][a-z0-9_-]{1,31}$/.test(provider) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(ref)
      )
        throw new ApiError(
          "VALIDATION_ERROR",
          "Invalid connection configuration",
          422,
        );
      if (
        !c.env.EXTERNAL_ADAPTER ||
        !c.env.EXTERNAL_ADAPTER_SHARED_SECRET ||
        !schemaRefreshInterval(c.env)
      )
        throw new ApiError(
          "EXTERNAL_UNAVAILABLE",
          "External Adapter is not configured",
          503,
        );
      const source: ExternalSource = {
        id: id("exs"),
        space_id: spaceId,
        provider_key: provider,
        credential_ref: ref,
        status: "active",
        created_at: now(),
        updated_at: now(),
      };
      const connection = objectInput(
        await callExternalAdapter(c.env, source, "connection", "connection"),
      );
      if (
        typeof connection.read !== "boolean" ||
        typeof connection.write !== "boolean"
      )
        throw new ApiError(
          "EXTERNAL_CONTRACT_INVALID",
          "Connection projection is invalid",
          502,
        );
      await c.env.DB.prepare(
        "INSERT INTO external_sources(id,space_id,provider_key,credential_ref,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
        .bind(
          source.id,
          source.space_id,
          source.provider_key,
          source.credential_ref,
          source.status,
          source.created_at,
          source.updated_at,
        )
        .run();
      return c.json(success(sourceDto(source)), 201);
    },
  );
  app.patch(sourcePath + "/:sourceId", async (c) => {
    await manager(c);
    const source = await getExternalSource(c.env, c.req.param("sourceId")!);
    if (!source || source.space_id !== c.req.param("spaceId")!)
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    const input = await body(c);
    onlyKeys(input, ["status"]);
    if (!["active", "disabled"].includes(String(input.status)))
      throw new ApiError("VALIDATION_ERROR", "Invalid connection status", 422);
    await c.env.DB.prepare(
      "UPDATE external_sources SET status=?,updated_at=? WHERE id=?",
    )
      .bind(input.status, now(), source.id)
      .run();
    return c.json(success({ ...sourceDto(source), status: input.status }));
  });
  app.get(modelPath, async (c) => {
    await manager(c);
    const rows = await c.env.DB.prepare(
      "SELECT * FROM external_models WHERE space_id=? ORDER BY created_at,model_key",
    )
      .bind(c.req.param("spaceId")!)
      .all<ExternalModelRow>();
    return c.json(
      success({
        items: rows.results.map((r) => ({
          modelKey: r.definition_key ?? r.model_key,
          registrationId: r.model_key,
          definitionKey: r.definition_key ?? null,
          spaceId: r.space_id,
          connectionId: r.source_id,
          sourceId: r.source_id,
          displayName: r.display_name,
          status: r.status,
          schemaHash: r.schema_hash,
          schemaObservedAt: r.schema_observed_at,
          lastErrorCode: r.last_error_code,
        })),
      }),
    );
  });
  app.post(modelPath, async (c) => {
    await manager(c);
    const input = await body(c);
    onlyKeys(input, ["connectionId", "sourceId", "resourceId", "declaredAccess", "definitionKey"]);
    if (input.connectionId !== undefined && input.sourceId !== undefined && input.connectionId !== input.sourceId) {
      throw new ApiError("VALIDATION_ERROR", "connectionId and legacy sourceId must identify the same connection", 422);
    }
    const rawConnectionId = input.connectionId ?? input.sourceId;
    const connectionId = boundedString(rawConnectionId, "connectionId");
    const definitionKey = input.definitionKey === undefined ? null : boundedString(input.definitionKey, "definitionKey", 63);
    if (definitionKey && (await getRuntimeModel(c.env, definitionKey))?.definition.origin !== "external") throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "Publish an External business definition before binding it", 422);
    const source = await getExternalSource(c.env, connectionId);
    if (
      !source ||
      source.space_id !== c.req.param("spaceId")! ||
      source.status !== "active"
    )
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    const resource = boundedString(input.resourceId, "resourceId");
    const declared = input.declaredAccess ?? "read";
    if (declared !== "read" && declared !== "write")
      throw new ApiError(
        "VALIDATION_ERROR",
        "declaredAccess must be read or write",
        422,
      );
    const snapshot = validateExternalSnapshot(
      await callExternalAdapter(c.env, source, "discover", resource),
    );
    const hash = await externalHash(snapshot);
    const previous = await c.env.DB.prepare(
      "SELECT model_key,space_id,status,definition_key FROM external_models WHERE provider_key=? AND resource_id=?",
    )
      .bind(source.provider_key, snapshot.resourceId)
      .first<{ model_key: string; space_id: string; status: string; definition_key: string | null }>();
    if (previous?.definition_key && definitionKey !== null && previous.definition_key !== definitionKey) throw new ApiError("EXTERNAL_DEFINITION_IMMUTABLE", "A binding cannot change its business definition", 409);
    if (
      previous &&
      (previous.space_id !== source.space_id || previous.status !== "disabled")
    )
      throw new ApiError(
        "EXTERNAL_RESOURCE_REGISTERED",
        "External resource is already registered",
        409,
      );
    const key = previous?.model_key ?? id("ext");
    const timestamp = now();
    try {
      if (previous) {
        const reactivated = await c.env.DB.prepare(
          `UPDATE external_models SET definition_key=COALESCE(definition_key,?),source_id=?,snapshot_json=?,schema_hash=?,schema_observed_at=?,display_name=?,declared_access=?,status='active',last_successful_refresh_at=?,last_error_code=NULL,next_refresh_at=?,updated_at=? WHERE model_key=? AND space_id=? AND status='disabled'`,
        )
          .bind(
            definitionKey,
            source.id,
            JSON.stringify(snapshot),
            hash,
            timestamp,
            snapshot.displayName,
            declared,
            timestamp,
            nextExternalRefresh(c.env),
            timestamp,
            key,
            source.space_id,
          )
          .run();
        if (!reactivated.meta.changes)
          throw new ApiError(
            "EXTERNAL_RESOURCE_REGISTERED",
            "Registration changed concurrently",
            409,
          );
      } else
        await c.env.DB.prepare(
          `INSERT INTO external_models(model_key,space_id,source_id,provider_key,resource_id,display_name,declared_access,snapshot_json,schema_hash,schema_observed_at,status,last_successful_refresh_at,next_refresh_at,created_at,updated_at,definition_key) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)`,
        )
          .bind(
            key,
            source.space_id,
            source.id,
            source.provider_key,
            snapshot.resourceId,
            snapshot.displayName,
            declared,
            JSON.stringify(snapshot),
            hash,
            timestamp,
            timestamp,
            nextExternalRefresh(c.env),
            timestamp,
            timestamp,
            definitionKey,
          )
          .run();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint"))
        throw new ApiError(
          "EXTERNAL_RESOURCE_REGISTERED",
          "External resource is already registered",
          409,
        );
      throw error;
    }
    const model = await getExternalModel(c.env, source.space_id, key);
    if (!model)
      throw new ApiError(
        "EXTERNAL_UNAVAILABLE",
        "Registration unavailable",
        503,
      );
    return c.json(success(externalSemanticDetail(model)), 201);
  });
  app.post(modelPath + "/:modelKey/refresh", async (c) => {
    await manager(c);
    const input = await body(c);
    onlyKeys(input, []);
    const m = await getExternalModel(
      c.env,
      c.req.param("spaceId")!,
      c.req.param("modelKey")!,
    );
    if (!m) throw new ApiError("NOT_FOUND", "Registration not found", 404);
    return c.json(
      success(externalSemanticDetail(await refreshExternalModel(c.env, m))),
    );
  });
  app.patch(modelPath + "/:modelKey", async (c) => {
    await manager(c);
    const input = await body(c);
    onlyKeys(input, ["status", "declaredAccess"]);
    const m = await getExternalModel(
      c.env,
      c.req.param("spaceId")!,
      c.req.param("modelKey")!,
      true,
    );
    if (!m) throw new ApiError("NOT_FOUND", "Registration not found", 404);
    if (input.status !== undefined && input.status !== "disabled")
      throw new ApiError(
        "VALIDATION_ERROR",
        "Use registration to reactivate a disabled identity",
        422,
      );
    if (
      input.declaredAccess !== undefined &&
      input.declaredAccess !== "read" &&
      input.declaredAccess !== "write"
    )
      throw new ApiError("VALIDATION_ERROR", "Invalid declared access", 422);
    if (!Object.keys(input).length)
      throw new ApiError("INVALID_REQUEST", "A change is required", 400);
    await c.env.DB.prepare(
      "UPDATE external_models SET status=?,declared_access=?,updated_at=? WHERE model_key=?",
    )
      .bind(
        input.status ?? m.status,
        input.declaredAccess ?? m.declared_access,
        now(),
        m.model_key,
      )
      .run();
    return c.json(
      success({
        modelKey: m.model_key,
        status: input.status ?? m.status,
        declaredAccess: input.declaredAccess ?? m.declared_access,
      }),
    );
  });
}

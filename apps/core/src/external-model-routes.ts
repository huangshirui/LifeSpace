import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import {
  assertDynamicCredentialRef,
  callExternalConnectionAdapter,
  externalConnectionDto,
  getExternalConnection,
  listExternalConnections,
  listExternalProviderDescriptors,
  validateConnectionCredential,
  validateConnectionDisplayName,
  validateConnectionProjection,
  validateConnectionResources,
  validateProviderDescriptor,
} from "./external-connections";
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
  return p;
}
async function body(c: Context<AppEnv>) {
  return objectInput(await c.req.json<unknown>().catch(() => null));
}
const id = (prefix: string) =>
  prefix + "_" + crypto.randomUUID().replaceAll("-", "");
const now = () => new Date().toISOString();
function providerKey(value: unknown): string {
  const key = boundedString(value, "providerKey", 32);
  if (!/^[a-z][a-z0-9_-]{1,31}$/u.test(key))
    throw new ApiError("VALIDATION_ERROR", "providerKey is invalid", 422);
  return key;
}
function connectionAccess(value: unknown): "read" | "write" {
  if (value !== "read" && value !== "write")
    throw new ApiError("VALIDATION_ERROR", "access must be read or write", 422);
  return value;
}
function resourceListInput(c: Context<AppEnv>): Record<string, unknown> {
  const url = new URL(c.req.url);
  for (const key of url.searchParams.keys()) {
    if (!["query", "cursor", "limit"].includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new ApiError("VALIDATION_ERROR", "Invalid resource discovery query", 422);
  }
  const query = url.searchParams.get("query");
  const cursor = url.searchParams.get("cursor");
  const rawLimit = url.searchParams.get("limit");
  if (query !== null && query.length > 200)
    throw new ApiError("VALIDATION_ERROR", "query is too long", 422);
  if (cursor !== null && cursor.length > 2048)
    throw new ApiError("VALIDATION_ERROR", "cursor is too long", 422);
  let limit: number | undefined;
  if (rawLimit !== null) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError("VALIDATION_ERROR", "limit is invalid", 422);
  }
  return {
    ...(query !== null ? { query } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function registerExternalModelControlRoutes(app: App) {
  const providerPath = "/api/v1/spaces/:spaceId/external-providers";
  const connectionPath = "/api/v1/spaces/:spaceId/external-connections";
  const modelPath = "/api/v1/spaces/:spaceId/external-models";
  for (const path of [providerPath, connectionPath, modelPath]) {
    app.use(path, requireScope("spaces:manage"));
    app.use(path + "/*", requireScope("spaces:manage"));
  }

  app.get(providerPath, async (c) => {
    await manager(c);
    return c.json(success({ items: await listExternalProviderDescriptors(c.env) }));
  });

  app.get(connectionPath, async (c) => {
    await manager(c);
    const rows = await listExternalConnections(c.env, c.req.param("spaceId")!);
    return c.json(success({ items: rows.map(externalConnectionDto) }));
  });

  app.post(connectionPath, async (c) => {
    const principal = await manager(c);
    if (!schemaRefreshInterval(c.env))
      throw new ApiError("EXTERNAL_UNAVAILABLE", "External schema refresh is not configured", 503);
    const input = await body(c);
    onlyKeys(input, ["providerKey", "displayName", "credential", "access"]);
    const provider = providerKey(input.providerKey);
    const displayName = validateConnectionDisplayName(input.displayName);
    const credential = validateConnectionCredential(input.credential);
    const access = connectionAccess(input.access);
    const descriptor = validateProviderDescriptor(
      await callExternalConnectionAdapter(c.env, { operation: "describe", providerKey: provider }),
    );
    if (descriptor.key !== provider || !descriptor.access.includes(access))
      throw new ApiError("EXTERNAL_PROVIDER_UNAVAILABLE", "External provider configuration is unavailable", 422);

    const sourceId = id("exs");
    const credentialRef = id("cnx");
    const projection = validateConnectionProjection(
      await callExternalConnectionAdapter(c.env, {
        operation: "create",
        providerKey: provider,
        credentialRef,
        credential,
        access,
      }),
    );
    if (access === "write" && !projection.write) {
      try {
        await callExternalConnectionAdapter(c.env, { operation: "delete", providerKey: provider, credentialRef });
      } catch { /* fail closed: unusable vault state has no Core metadata */ }
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "Provider connection does not allow write access", 422);
    }
    const timestamp = now();
    try {
      await c.env.DB.prepare(
        "INSERT INTO external_sources(id,space_id,provider_key,credential_ref,status,display_name,access_mode,created_by_user_id,revoked_at,created_at,updated_at) VALUES(?,?,?,?,'active',?,?,?,?,?,?)",
      ).bind(
        sourceId,
        c.req.param("spaceId")!,
        provider,
        credentialRef,
        displayName,
        projection.write ? "write" : "read",
        principal.id,
        null,
        timestamp,
        timestamp,
      ).run();
    } catch (error) {
      try {
        await callExternalConnectionAdapter(c.env, { operation: "delete", providerKey: provider, credentialRef });
      } catch { /* best-effort compensation; orphan vault has no Core address */ }
      throw error;
    }
    const created = await getExternalConnection(c.env, sourceId);
    if (!created) throw new ApiError("EXTERNAL_UNAVAILABLE", "Connection metadata is unavailable", 503);
    return c.json(success(externalConnectionDto(created)), 201);
  });

  app.get(connectionPath + "/:connectionId/resources", async (c) => {
    await manager(c);
    const connection = await getExternalConnection(c.env, c.req.param("connectionId")!);
    if (!connection || connection.space_id !== c.req.param("spaceId")!)
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    if (connection.revoked_at || connection.status !== "active")
      throw new ApiError("EXTERNAL_CONNECTION_DISABLED", "Connection is not active", 409);
    assertDynamicCredentialRef(connection.credential_ref);
    const result = validateConnectionResources(
      await callExternalConnectionAdapter(c.env, {
        operation: "listResources",
        providerKey: connection.provider_key,
        credentialRef: connection.credential_ref,
        input: resourceListInput(c),
      }),
    );
    return c.json(success(result));
  });

  app.patch(connectionPath + "/:connectionId", async (c) => {
    await manager(c);
    const connection = await getExternalConnection(c.env, c.req.param("connectionId")!);
    if (!connection || connection.space_id !== c.req.param("spaceId")!)
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    if (connection.revoked_at)
      throw new ApiError("EXTERNAL_CONNECTION_REVOKED", "Connection has been revoked", 409);
    assertDynamicCredentialRef(connection.credential_ref);
    const input = await body(c);
    onlyKeys(input, ["displayName", "credential", "access", "status"]);
    if (!Object.keys(input).length) throw new ApiError("INVALID_REQUEST", "A change is required", 400);
    const nextDisplayName = input.displayName === undefined
      ? connection.display_name
      : validateConnectionDisplayName(input.displayName);
    let nextAccess = connection.access_mode;
    if (input.access !== undefined || input.credential !== undefined) {
      const requestedAccess = input.access === undefined ? undefined : connectionAccess(input.access);
      const credential = input.credential === undefined ? undefined : validateConnectionCredential(input.credential);
      const projection = validateConnectionProjection(
        await callExternalConnectionAdapter(c.env, {
          operation: "update",
          providerKey: connection.provider_key,
          credentialRef: connection.credential_ref,
          ...(credential ? { credential } : {}),
          ...(requestedAccess ? { access: requestedAccess } : {}),
        }),
      );
      if (requestedAccess === "write" && !projection.write)
        throw new ApiError("EXTERNAL_VALIDATION_FAILED", "Provider connection does not allow write access", 422);
      nextAccess = projection.write ? "write" : "read";
    }
    const nextStatus = input.status === undefined ? connection.status : String(input.status);
    if (nextStatus !== "active" && nextStatus !== "disabled")
      throw new ApiError("VALIDATION_ERROR", "status must be active or disabled", 422);
    const timestamp = now();
    await c.env.DB.prepare(
      "UPDATE external_sources SET display_name=?,access_mode=?,status=?,updated_at=? WHERE id=? AND revoked_at IS NULL",
    ).bind(nextDisplayName, nextAccess, nextStatus, timestamp, connection.id).run();
    const updated = await getExternalConnection(c.env, connection.id);
    if (!updated) throw new ApiError("EXTERNAL_UNAVAILABLE", "Connection metadata is unavailable", 503);
    return c.json(success(externalConnectionDto(updated)));
  });

  app.delete(connectionPath + "/:connectionId", async (c) => {
    await manager(c);
    const connection = await getExternalConnection(c.env, c.req.param("connectionId")!);
    if (!connection || connection.space_id !== c.req.param("spaceId")!)
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    if (connection.revoked_at) return c.body(null, 204);
    assertDynamicCredentialRef(connection.credential_ref);
    await callExternalConnectionAdapter(c.env, {
      operation: "delete",
      providerKey: connection.provider_key,
      credentialRef: connection.credential_ref,
    });
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE external_sources SET status='disabled',revoked_at=?,updated_at=? WHERE id=? AND revoked_at IS NULL",
      ).bind(timestamp, timestamp, connection.id),
      c.env.DB.prepare(
        "UPDATE external_models SET status='disabled',next_refresh_at=NULL,updated_at=? WHERE source_id=? AND status!='disabled'",
      ).bind(timestamp, connection.id),
    ]);
    return c.body(null, 204);
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
          displayName: r.display_name,
          status: r.status,
          declaredAccess: r.declared_access,
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
    onlyKeys(input, ["connectionId", "resourceId", "declaredAccess", "definitionKey"]);
    const definitionKey = boundedString(input.definitionKey, "definitionKey", 63);
    const businessDefinition = await getRuntimeModel(c.env, definitionKey);
    if (businessDefinition?.definition.origin !== "external")
      throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "Publish an External business definition before binding it", 422);
    const source = await getExternalSource(
      c.env,
      boundedString(input.connectionId, "connectionId"),
    );
    if (
      !source ||
      source.space_id !== c.req.param("spaceId")! ||
      source.status !== "active"
    )
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    const connection = await getExternalConnection(c.env, source.id);
    if (!connection || connection.revoked_at)
      throw new ApiError("EXTERNAL_CONNECTION_REVOKED", "Connection has been revoked", 409);
    assertDynamicCredentialRef(connection.credential_ref);
    const resource = boundedString(input.resourceId, "resourceId");
    const declared = input.declaredAccess ?? "read";
    if (declared !== "read" && declared !== "write")
      throw new ApiError(
        "VALIDATION_ERROR",
        "declaredAccess must be read or write",
        422,
      );
    if (declared === "write" && connection.access_mode !== "write")
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "Connection is read-only", 422);
    if (declared === "write" && !businessDefinition.definition.access.includes("write"))
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "External Model Definition is read-only", 422);
    const snapshot = validateExternalSnapshot(
      await callExternalAdapter(c.env, source, "discover", resource),
    );
    const hash = await externalHash(snapshot);
    const previous = await c.env.DB.prepare(
      "SELECT model_key,space_id,status,definition_key FROM external_models WHERE provider_key=? AND resource_id=?",
    )
      .bind(source.provider_key, snapshot.resourceId)
      .first<{ model_key: string; space_id: string; status: string; definition_key: string | null }>();
    if (previous?.definition_key && previous.definition_key !== definitionKey)
      throw new ApiError("EXTERNAL_DEFINITION_IMMUTABLE", "A binding cannot change its business definition", 409);
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
          `UPDATE external_models SET definition_key=?,source_id=?,snapshot_json=?,schema_hash=?,schema_observed_at=?,display_name=?,declared_access=?,status='active',last_successful_refresh_at=?,last_error_code=NULL,next_refresh_at=?,updated_at=? WHERE model_key=? AND space_id=? AND status='disabled'`,
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
    return c.json(success({ ...externalSemanticDetail(model), connectionId: source.id }), 201);
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
    if (input.declaredAccess === "write") {
      const connection = await getExternalConnection(c.env, m.source_id);
      if (!connection || connection.access_mode !== "write")
        throw new ApiError("EXTERNAL_VALIDATION_FAILED", "Connection is read-only", 422);
      assertDynamicCredentialRef(connection.credential_ref);
      if (!m.definition_key)
        throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "External Model Definition is unavailable", 422);
      const businessDefinition = await getRuntimeModel(c.env, m.definition_key);
      if (businessDefinition?.definition.origin !== "external" || !businessDefinition.definition.access.includes("write"))
        throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "External Model Definition does not allow write access", 422);
    }
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
        modelKey: m.definition_key ?? m.model_key,
        status: input.status ?? m.status,
        declaredAccess: input.declaredAccess ?? m.declared_access,
      }),
    );
  });
}

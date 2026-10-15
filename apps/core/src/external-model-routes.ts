import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { requirePlatformAdminContext, type PlatformAdminContext } from "./platform-admin-auth";
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
type AuthorityMode = "space-user" | "platform-admin";

async function directManager(c: Context<AppEnv>) {
  const principal = c.get("principal");
  if (principal.type !== "user" || principal.actor)
    throw new ApiError("FORBIDDEN", "Direct User management is required", 403);
  await requireSpacePermission(c.env, principal, c.req.param("spaceId")!, "manage");
  return principal;
}

async function authorize(c: Context<AppEnv>, mode: AuthorityMode): Promise<{ actorUserId: string; admin?: PlatformAdminContext }> {
  if (mode === "space-user") {
    const principal = await directManager(c);
    return { actorUserId: principal.id };
  }
  const admin = await requirePlatformAdminContext(c, "spaces:manage");
  return { actorUserId: admin.actor.id, admin };
}

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

async function beginPlatformAudit(c: Context<AppEnv>, admin: PlatformAdminContext, operation: string, summary: Record<string, unknown>): Promise<string> {
  const auditId = createId("paa");
  await c.env.DB.prepare(`INSERT INTO platform_admin_audit(
    id,actor_user_id,actor_application_id,actor_token_id,
    executor_principal_id,executor_application_id,executor_token_id,
    operation,target_type,target_id,summary_json,request_id,result,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    auditId,
    admin.actor.id,
    admin.actor.clientId,
    admin.actor.tokenId,
    admin.executor.id,
    admin.executor.clientId,
    admin.executor.tokenId,
    operation,
    "space",
    c.req.param("spaceId")!,
    JSON.stringify(summary),
    c.get("requestId"),
    "pending",
    now(),
  ).run();
  return auditId;
}

async function finishPlatformAudit(c: Context<AppEnv>, auditId: string, result: "success" | "failure", summary: Record<string, unknown>): Promise<void> {
  await c.env.DB.prepare("UPDATE platform_admin_audit SET result=?,summary_json=? WHERE id=? AND result='pending'")
    .bind(result, JSON.stringify(summary), auditId).run();
}

async function managedMutation<T>(
  c: Context<AppEnv>,
  mode: AuthorityMode,
  operation: string,
  action: (actorUserId: string) => Promise<T>,
): Promise<T> {
  const authority = await authorize(c, mode);
  if (!authority.admin) return action(authority.actorUserId);
  const baseSummary = { spaceId: c.req.param("spaceId")!, path: c.req.path };
  const auditId = await beginPlatformAudit(c, authority.admin, operation, baseSummary);
  try {
    const value = await action(authority.actorUserId);
    try { await finishPlatformAudit(c, auditId, "success", baseSummary); }
    catch (error) { console.error(JSON.stringify({ message: "Platform external governance audit completion failed", auditId, requestId: c.get("requestId"), error: error instanceof Error ? error.message : String(error) })); }
    return value;
  } catch (error) {
    try { await finishPlatformAudit(c, auditId, "failure", { ...baseSummary, errorCode: error instanceof ApiError ? error.code : "INTERNAL_ERROR" }); }
    catch (auditError) { console.error(JSON.stringify({ message: "Platform external governance failure audit completion failed", auditId, requestId: c.get("requestId"), error: auditError instanceof Error ? auditError.message : String(auditError) })); }
    throw error;
  }
}

async function body(c: Context<AppEnv>) {
  return objectInput(await c.req.json<unknown>().catch(() => null));
}

const id = (prefix: string) => prefix + "_" + crypto.randomUUID().replaceAll("-", "");

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

function registerRouteSet(app: App, base: string, mode: AuthorityMode): void {
  const providerPath = `${base}/external-providers`;
  const connectionPath = `${base}/external-connections`;
  const modelPath = `${base}/external-models`;
  if (mode === "space-user") {
    for (const path of [providerPath, connectionPath, modelPath]) {
      app.use(path, requireScope("spaces:manage"));
      app.use(path + "/*", requireScope("spaces:manage"));
    }
  }

  app.get(providerPath, async (c) => {
    await authorize(c, mode);
    return c.json(success({ items: await listExternalProviderDescriptors(c.env) }));
  });

  app.get(connectionPath, async (c) => {
    await authorize(c, mode);
    const rows = await listExternalConnections(c.env, c.req.param("spaceId")!);
    return c.json(success({ items: rows.map(externalConnectionDto) }));
  });

  app.post(connectionPath, async (c) => managedMutation(c, mode, "external_connection.create", async (actorUserId) => {
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
      try { await callExternalConnectionAdapter(c.env, { operation: "delete", providerKey: provider, credentialRef }); }
      catch { /* fail closed: unusable vault state has no Core metadata */ }
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
        actorUserId,
        null,
        timestamp,
        timestamp,
      ).run();
    } catch (error) {
      try { await callExternalConnectionAdapter(c.env, { operation: "delete", providerKey: provider, credentialRef }); }
      catch { /* best-effort compensation; orphan vault has no Core address */ }
      throw error;
    }
    const created = await getExternalConnection(c.env, sourceId);
    if (!created) throw new ApiError("EXTERNAL_UNAVAILABLE", "Connection metadata is unavailable", 503);
    return c.json(success(externalConnectionDto(created)), 201);
  }));

  app.get(connectionPath + "/:connectionId/resources", async (c) => {
    await authorize(c, mode);
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

  app.patch(connectionPath + "/:connectionId", async (c) => managedMutation(c, mode, "external_connection.update", async () => {
    const connection = await getExternalConnection(c.env, c.req.param("connectionId")!);
    if (!connection || connection.space_id !== c.req.param("spaceId")!)
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    if (connection.revoked_at)
      throw new ApiError("EXTERNAL_CONNECTION_REVOKED", "Connection has been revoked", 409);
    assertDynamicCredentialRef(connection.credential_ref);
    const input = await body(c);
    onlyKeys(input, ["displayName", "credential", "access", "status"]);
    if (!Object.keys(input).length) throw new ApiError("INVALID_REQUEST", "A change is required", 400);
    const nextDisplayName = input.displayName === undefined ? connection.display_name : validateConnectionDisplayName(input.displayName);
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
  }));

  app.delete(connectionPath + "/:connectionId", async (c) => managedMutation(c, mode, "external_connection.revoke", async () => {
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
  }));

  app.get(modelPath, async (c) => {
    await authorize(c, mode);
    const rows = await c.env.DB.prepare("SELECT * FROM external_models WHERE space_id=? ORDER BY created_at,model_key")
      .bind(c.req.param("spaceId")!).all<ExternalModelRow>();
    return c.json(success({
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
    }));
  });

  app.get(modelPath + "/:modelKey", async (c) => {
    await authorize(c, mode);
    const model = await getExternalModel(c.env, c.req.param("spaceId")!, c.req.param("modelKey")!, true);
    if (!model) throw new ApiError("NOT_FOUND", "Registration not found", 404);
    return c.json(success({ ...externalSemanticDetail(model), connectionId: model.source_id }));
  });

  app.post(modelPath, async (c) => managedMutation(c, mode, "external_model.bind", async () => {
    const input = await body(c);
    onlyKeys(input, ["connectionId", "resourceId", "declaredAccess", "definitionKey"]);
    const definitionKey = boundedString(input.definitionKey, "definitionKey", 63);
    const businessDefinition = await getRuntimeModel(c.env, definitionKey);
    if (businessDefinition?.definition.origin !== "external")
      throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "Publish an External business definition before binding it", 422);
    const source = await getExternalSource(c.env, boundedString(input.connectionId, "connectionId"));
    if (!source || source.space_id !== c.req.param("spaceId")! || source.status !== "active")
      throw new ApiError("NOT_FOUND", "Connection not found", 404);
    const connection = await getExternalConnection(c.env, source.id);
    if (!connection || connection.revoked_at)
      throw new ApiError("EXTERNAL_CONNECTION_REVOKED", "Connection has been revoked", 409);
    assertDynamicCredentialRef(connection.credential_ref);
    const resource = boundedString(input.resourceId, "resourceId");
    const declared = input.declaredAccess ?? "read";
    if (declared !== "read" && declared !== "write")
      throw new ApiError("VALIDATION_ERROR", "declaredAccess must be read or write", 422);
    if (declared === "write" && connection.access_mode !== "write")
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "Connection is read-only", 422);
    if (declared === "write" && !businessDefinition.definition.access.includes("write"))
      throw new ApiError("EXTERNAL_VALIDATION_FAILED", "External Model Definition is read-only", 422);
    const snapshot = validateExternalSnapshot(await callExternalAdapter(c.env, source, "discover", resource));
    const hash = await externalHash(snapshot);
    const previous = await c.env.DB.prepare(
      "SELECT model_key,space_id,status,definition_key FROM external_models WHERE provider_key=? AND resource_id=?",
    ).bind(source.provider_key, snapshot.resourceId).first<{ model_key: string; space_id: string; status: string; definition_key: string | null }>();
    if (previous?.definition_key && previous.definition_key !== definitionKey)
      throw new ApiError("EXTERNAL_DEFINITION_IMMUTABLE", "A binding cannot change its business definition", 409);
    if (previous && (previous.space_id !== source.space_id || previous.status !== "disabled"))
      throw new ApiError("EXTERNAL_RESOURCE_REGISTERED", "External resource is already registered", 409);
    const key = previous?.model_key ?? id("ext");
    const timestamp = now();
    try {
      if (previous) {
        const reactivated = await c.env.DB.prepare(
          `UPDATE external_models SET definition_key=?,source_id=?,snapshot_json=?,schema_hash=?,schema_observed_at=?,display_name=?,declared_access=?,status='active',last_successful_refresh_at=?,last_error_code=NULL,next_refresh_at=?,updated_at=? WHERE model_key=? AND space_id=? AND status='disabled'`,
        ).bind(
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
        ).run();
        if (!reactivated.meta.changes)
          throw new ApiError("EXTERNAL_RESOURCE_REGISTERED", "Registration changed concurrently", 409);
      } else {
        await c.env.DB.prepare(
          `INSERT INTO external_models(model_key,space_id,source_id,provider_key,resource_id,display_name,declared_access,snapshot_json,schema_hash,schema_observed_at,status,last_successful_refresh_at,next_refresh_at,created_at,updated_at,definition_key) VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?)`,
        ).bind(
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
        ).run();
      }
    } catch (error) {
      if (String(error).includes("UNIQUE constraint"))
        throw new ApiError("EXTERNAL_RESOURCE_REGISTERED", "External resource is already registered", 409);
      throw error;
    }
    const model = await getExternalModel(c.env, source.space_id, key);
    if (!model) throw new ApiError("EXTERNAL_UNAVAILABLE", "Registration unavailable", 503);
    return c.json(success({ ...externalSemanticDetail(model), connectionId: source.id }), 201);
  }));

  app.post(modelPath + "/:modelKey/refresh", async (c) => managedMutation(c, mode, "external_model.refresh", async () => {
    const input = await body(c);
    onlyKeys(input, []);
    const model = await getExternalModel(c.env, c.req.param("spaceId")!, c.req.param("modelKey")!);
    if (!model) throw new ApiError("NOT_FOUND", "Registration not found", 404);
    return c.json(success(externalSemanticDetail(await refreshExternalModel(c.env, model))));
  }));

  app.patch(modelPath + "/:modelKey", async (c) => managedMutation(c, mode, "external_model.update", async () => {
    const input = await body(c);
    onlyKeys(input, ["status", "declaredAccess"]);
    const model = await getExternalModel(c.env, c.req.param("spaceId")!, c.req.param("modelKey")!, true);
    if (!model) throw new ApiError("NOT_FOUND", "Registration not found", 404);
    if (input.status !== undefined && input.status !== "disabled")
      throw new ApiError("VALIDATION_ERROR", "Use registration to reactivate a disabled identity", 422);
    if (input.declaredAccess !== undefined && input.declaredAccess !== "read" && input.declaredAccess !== "write")
      throw new ApiError("VALIDATION_ERROR", "Invalid declared access", 422);
    if (!Object.keys(input).length) throw new ApiError("INVALID_REQUEST", "A change is required", 400);
    if (input.declaredAccess === "write") {
      const connection = await getExternalConnection(c.env, model.source_id);
      if (!connection || connection.access_mode !== "write")
        throw new ApiError("EXTERNAL_VALIDATION_FAILED", "Connection is read-only", 422);
      assertDynamicCredentialRef(connection.credential_ref);
      if (!model.definition_key)
        throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "External Model Definition is unavailable", 422);
      const businessDefinition = await getRuntimeModel(c.env, model.definition_key);
      if (businessDefinition?.definition.origin !== "external" || !businessDefinition.definition.access.includes("write"))
        throw new ApiError("EXTERNAL_DEFINITION_UNAVAILABLE", "External Model Definition does not allow write access", 422);
    }
    await c.env.DB.prepare("UPDATE external_models SET status=?,declared_access=?,updated_at=? WHERE model_key=?")
      .bind(input.status ?? model.status, input.declaredAccess ?? model.declared_access, now(), model.model_key).run();
    return c.json(success({
      modelKey: model.definition_key ?? model.model_key,
      status: input.status ?? model.status,
      declaredAccess: input.declaredAccess ?? model.declared_access,
    }));
  }));
}

export function registerExternalModelControlRoutes(app: App): void {
  registerRouteSet(app, "/api/v1/spaces/:spaceId", "space-user");
  registerRouteSet(app, "/api/v1/platform-admin/spaces/:spaceId", "platform-admin");
}

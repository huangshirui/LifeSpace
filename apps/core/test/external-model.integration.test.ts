import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";
import { reconcileExternalModels } from "../src/external-model";

const field = "f_" + "a".repeat(32),
  shared = "synthetic-external-shared-secret-at-least-32-chars";
const pem = (label: string, bytes: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${btoa(
    String.fromCharCode(...new Uint8Array(bytes)),
  )
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END ${label}-----`;

async function fixture(definitionKey?: string) {
  const db = (env as unknown as { DB: D1Database }).DB,
    app = createApp(),
    suffix = crypto.randomUUID().replaceAll("-", "");
  const space = "spc_" + suffix,
    user = "usr_" + suffix,
    application = "app_" + suffix,
    resource = "synthetic_resource_" + suffix,
    businessKey = definitionKey ?? `external_synthetic_${suffix.slice(0, 12)}`,
    providerToken = `synthetic-provider-token-${suffix}`;
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const privateKey = pem(
      "PRIVATE KEY",
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ),
    publicKey = pem(
      "PUBLIC KEY",
      await crypto.subtle.exportKey("spki", pair.publicKey),
    );
  await db.batch([
    db
      .prepare(
        "INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        space,
        "Synthetic Space",
        user,
        new Date().toISOString(),
        new Date().toISOString(),
        "UTC",
      ),
    db
      .prepare(
        "INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        "mem_" + suffix,
        space,
        user,
        "owner",
        new Date().toISOString(),
        new Date().toISOString(),
      ),
  ]);
  const state = {
    calls: [] as string[],
    active: 0,
    maxActive: 0,
    type: "number",
    title: "Amount",
    cursor: null as string | null,
    error: null as string | null,
    mismatch: 0,
    failAudit: false,
    returnedRecordId: null as string | null,
    endpointErrors: {} as Record<string, string>,
  };
  const snapshot = () => ({
    resourceId: resource,
    displayName: "Synthetic records",
    fields: [
      {
        key: field,
        sourceFieldId: "stable_property",
        title: state.title,
        type: state.type,
        nullable: true,
        readable: true,
        writable: true,
        operators: state.type === "number" ? ["eq", "ne", "gt"] : ["eq", "ne"],
        sortable: true,
      },
    ],
    capabilities: {
      get: true,
      query: true,
      create: true,
      update: true,
      delete: true,
      batchWrite: true,
      atomicBatch: false,
      transaction: false,
      versionedWrite: false,
      actions: false,
      relationTargetResolution: false,
    },
    queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
    adapterState: {
      codecs: { [field]: { id: "stable_property", type: state.type } },
    },
  });
  const record = (id = "rec_external_" + suffix) => ({
    id: state.returnedRecordId ?? id,
    data: { [field]: state.type === "number" ? 8 : "eight" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const binding = {
    async fetch(url: RequestInfo | URL, init?: RequestInit) {
      const req = new Request(url, init);
      expect(req.headers.get("x-lifespace-internal-secret")).toBe(shared);
      const pathname = new URL(req.url).pathname;
      const r = (await req.json()) as {
        operation: string;
        providerKey?: string;
        credentialRef?: string;
        credential?: Record<string, unknown>;
        access?: "read" | "write";
        recordId?: string;
      };
      if (pathname === "/internal/v1/external-connections") {
        if (r.operation === "describe") {
          return Response.json({
            contractVersion: 1,
            data: {
              key: "synthetic",
              displayName: "Synthetic Provider",
              credential: { type: "bearer_token", displayName: "Provider token" },
              resource: { type: "data_source", displayName: "Data source" },
              access: ["read", "write"],
            },
          });
        }
        if (r.operation === "create" || r.operation === "update") {
          expect(r.credentialRef).toMatch(/^cnx_[a-f0-9]{32}$/u);
          return Response.json({
            contractVersion: 1,
            data: { read: true, write: r.access !== "read" },
          });
        }
        if (r.operation === "listResources") {
          expect(r.credentialRef).toMatch(/^cnx_[a-f0-9]{32}$/u);
          return Response.json({
            contractVersion: 1,
            data: {
              items: [{ id: resource, type: "data_source", displayName: "Synthetic records" }],
              nextCursor: null,
            },
          });
        }
        if (r.operation === "delete") {
          expect(r.credentialRef).toMatch(/^cnx_[a-f0-9]{32}$/u);
          return Response.json({ contractVersion: 1, data: { deleted: true } });
        }
        return Response.json(
          { contractVersion: 1, error: { code: "EXTERNAL_CONTRACT_INVALID", retrySafe: false } },
          { status: 502 },
        );
      }

      state.calls.push(r.operation);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      await Promise.resolve();
      state.active--;
      const providerError = state.error ?? (r.recordId ? state.endpointErrors[r.recordId] : undefined);
      if (providerError)
        return Response.json(
          {
            contractVersion: 1,
            error: { code: providerError, retrySafe: false },
          },
          { status: 503 },
        );
      if (state.mismatch > 0 && r.operation !== "discover") {
        state.mismatch--;
        return Response.json(
          {
            contractVersion: 1,
            error: { code: "EXTERNAL_SCHEMA_CHANGED", retrySafe: true },
          },
          { status: 409 },
        );
      }
      const data =
        r.operation === "connection"
          ? { read: true, write: true }
          : r.operation === "discover"
            ? snapshot()
            : r.operation === "query"
              ? { items: [record()], nextCursor: state.cursor }
              : r.operation === "delete"
                ? { id: state.returnedRecordId ?? r.recordId }
                : record(
                    r.recordId ??
                      "rec_external_" + crypto.randomUUID().replaceAll("-", ""),
                  );
      return Response.json({ contractVersion: 1, data });
    },
  } as Fetcher;
  const metric = { d1: 0 };
  const targets = new WeakMap<object, D1PreparedStatement>();
  const sqlByStatement = new WeakMap<object, string>();
  const counted = (
    statement: D1PreparedStatement,
    sql = "",
  ): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => counted(statement.bind(...args), sql);
        if (["first", "all", "run", "raw"].includes(String(key)))
          return (...args: unknown[]) => {
            metric.d1++;
            return (statement as any)[key](...args);
          };
        return Reflect.get(target, key, statement);
      },
    });
    targets.set(proxy, statement);
    sqlByStatement.set(proxy, sql);
    return proxy;
  };
  const countedDb = new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => counted(db.prepare(sql), sql);
      if (key === "batch")
        return (statements: D1PreparedStatement[]) => {
          metric.d1++;
          if (
            state.failAudit &&
            statements.some((s) =>
              sqlByStatement
                .get(s)
                ?.startsWith("INSERT INTO external_operation_audit"),
            )
          )
            throw Error("synthetic pending audit unavailable");
          return db.batch(statements.map((s) => targets.get(s) ?? s));
        };
      const value = Reflect.get(target, key, db);
      return typeof value === "function" ? value.bind(db) : value;
    },
  });
  const bindings = {
    DB: countedDb,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    EXTERNAL_PROVIDER_ROUTES: JSON.stringify({
      synthetic: {
        binding: "EXTERNAL_ADAPTER_SYNTHETIC",
        sharedSecret: "EXTERNAL_ADAPTER_SYNTHETIC_SHARED_SECRET",
      },
    }),
    EXTERNAL_ADAPTER_SYNTHETIC: binding,
    EXTERNAL_ADAPTER_SYNTHETIC_SHARED_SECRET: shared,
    EXTERNAL_CURSOR_SECRET: "synthetic-cursor-secret-independent-at-least-32-chars",
    EXTERNAL_SCHEMA_REFRESH_SECONDS: "60",
  } as unknown as Bindings;
  async function token(
    id = user,
    type = "user",
    scopes = [
      "spaces:manage",
      "resources:read",
      "resources:write",
      "grants:manage",
      "delegations:manage",
    ],
    actor?: string,
  ) {
    const now = Math.floor(Date.now() / 1000);
    return sign(
      {
        iss: "lifespace-identity",
        aud: "lifespace-core",
        sub: actor ?? id,
        principal_type: type,
        azp: application,
        scope: scopes.join(" "),
        iat: now,
        exp: now + 900,
        jti: "tok_" + suffix,
        ...(actor
          ? {
              actor_type: "agent",
              actor_id: actor,
              principal_id: id,
              purpose: "agent_execution",
            }
          : {}),
      },
      privateKey,
      "RS256",
    );
  }
  const bearer = await token();
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    access = bearer,
    headers: Record<string, string> = {},
  ) =>
    app.request(
      "https://example.com" + path,
      {
        method,
        headers: {
          authorization: "Bearer " + access,
          "content-type": "application/json",
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      bindings,
    );
  const sourceAdmin = await token("svc_synthetic", "service", [
    "models:manage",
  ]);
  const published = await request("/api/v1/model-admin/models", "POST", {
    definition: {
      definitionVersion: 1,
      origin: "external",
      key: businessKey,
      display: { singular: "Document", plural: "Documents" },
      fields: {},
      access: ["read", "write"],
      semanticRelations: { outgoing: ["relates_to"] },
    },
    compatibility: "initial",
  }, sourceAdmin);
  expect(published.status, JSON.stringify(await published.clone().json())).toBe(201);

  const cr = await request(`/api/v1/spaces/${space}/external-connections`, "POST", {
    providerKey: "synthetic",
    displayName: "Synthetic connection",
    credential: { type: "bearer_token", token: providerToken },
    access: "write",
  });
  expect(cr.status, JSON.stringify(await cr.clone().json())).toBe(201);
  const source = ((await cr.json()) as any).data.id;

  const mr = await request(`/api/v1/spaces/${space}/external-models`, "POST", {
    connectionId: source,
    definitionKey: businessKey,
    resourceId: resource,
    declaredAccess: "write",
  });
  expect(mr.status, JSON.stringify(await mr.clone().json())).toBe(201);
  const bindingData = ((await mr.json()) as any).data;
  const model = bindingData.key;
  const registration = bindingData.registrationId;
  const path = `/api/v1/spaces/${space}/models/${model}/records`;
  const authorize = () =>
    db
      .prepare(
        "INSERT OR REPLACE INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)",
      )
      .bind(application, model, "write", "service", "svc_synthetic")
      .run();
  return {
    db,
    space,
    user,
    application,
    source,
    sourceAdmin,
    model,
    registration,
    path,
    state,
    metric,
    bindings,
    request,
    token,
    resource,
    providerToken,
    authorize,
  };
}

describe("Space-local External Model framework", () => {
  it("keeps independent non-atomic items successful when one Provider endpoint fails", async () => {
    const f = await fixture("external_partial_endpoints"); await f.authorize();
    await f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,'task','write','service','svc_synthetic')").bind(f.application).run();
    const native = await f.request(`/api/v1/spaces/${f.space}/models/task/records`, "POST", { name: "Synthetic source" });
    expect(native.status).toBe(201);
    const source = { kind: "record", modelKey: "task", recordId: (await native.json<any>()).data.id };
    f.state.endpointErrors.rec_external_unavailable = "EXTERNAL_UNAVAILABLE";
    const result = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations: [
      { operation: "relation_create", source, predicate: "generated_from", target: { kind: "record", modelKey: f.model, recordId: "rec_external_unavailable" } },
      { operation: "relation_create", source, predicate: "generated_from", target: { kind: "record", modelKey: f.model, recordId: "rec_external_available" } },
      { operation: "create", modelKey: "task", data: { name: "Independent survivor" } },
    ] });
    expect(result.status).toBe(200);
    const items = (await result.json<any>()).data.items;
    expect(items.map(item => item.status)).toEqual(["failed", "succeeded", "succeeded"]);
    expect(items[0].error.code).toBe("EXTERNAL_UNAVAILABLE");
    expect((await f.request(`/api/v1/spaces/${f.space}/models/task/records/${items[2].recordId}`)).status).toBe(200);
  });

  it("retired business bindings do not starve active schema refresh and republishing resumes them", async () => {
    const f = await fixture("external_retired_queue");
    await f.authorize();
    expect((await f.request(`${f.path}/rec_external_retired_observation`)).status).toBe(200);
    for (let i = 0; i < 20; i++) {
      const space = `spc_retired_queue_${i}`, source = `exs_retired_queue_${i}`;
      await f.db.batch([
        f.db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) SELECT ?,name,created_by_user_id,created_at,updated_at,timezone FROM spaces WHERE id=?").bind(space, f.space),
        f.db.prepare("INSERT INTO external_sources(id,space_id,provider_key,credential_ref,status,created_at,updated_at) SELECT ?,?,provider_key,credential_ref,status,created_at,updated_at FROM external_sources WHERE id=?").bind(source, space, f.source),
        f.db.prepare("INSERT INTO external_models(model_key,space_id,source_id,provider_key,resource_id,display_name,declared_access,snapshot_json,schema_hash,schema_observed_at,status,last_successful_refresh_at,next_refresh_at,created_at,updated_at,definition_key) SELECT ?,?,?,provider_key,?,display_name,declared_access,snapshot_json,schema_hash,schema_observed_at,status,last_successful_refresh_at,'2000-01-01T00:00:00.000Z',created_at,updated_at,definition_key FROM external_models WHERE space_id=?").bind(`ext_retired_queue_${i}`, space, source, `synthetic_retired_resource_${i}`, f.space),
      ]);
    }
    await f.db.prepare("UPDATE external_models SET next_refresh_at='2000-01-01T00:00:00.000Z' WHERE space_id=?").bind(f.space).run();
    const retired = await f.request(`/api/v1/model-admin/models/${f.model}/retire`, "POST", {}, f.sourceAdmin);
    expect(retired.status).toBe(204);
    const parked = await f.db.prepare("SELECT COUNT(*) count FROM external_models WHERE definition_key=? AND next_refresh_at IS NOT NULL").bind(f.model).first<any>();
    expect(parked.count).toBe(0);
    await f.db.prepare("UPDATE external_sources SET status='disabled' WHERE id=?").bind(f.source).run();
    await f.db.prepare("UPDATE external_sources SET status='active' WHERE id=?").bind(f.source).run();
    expect((await f.db.prepare("SELECT next_refresh_at FROM external_models WHERE space_id=?").bind(f.space).first<any>()).next_refresh_at).toBeNull();
    expect((await f.db.prepare("SELECT next_check_at FROM external_record_identities WHERE space_id=?").bind(f.space).first<any>()).next_check_at).toBeNull();
    const other = await fixture();
    await other.db.prepare("UPDATE external_models SET next_refresh_at='2001-01-01T00:00:00.000Z' WHERE space_id=?").bind(other.space).run();
    f.state.calls = []; await reconcileExternalModels(f.bindings);
    expect(f.state.calls).toEqual(["discover"]);
    const definition = { definitionVersion: 1, origin: "external", key: f.model, display: { singular: "Document", plural: "Documents" }, fields: {}, access: ["read", "write"], semanticRelations: { outgoing: ["relates_to"] } };
    const republished = await f.request("/api/v1/model-admin/models", "POST", { definition, compatibility: "compatible" }, f.sourceAdmin);
    expect(republished.status).toBe(201);
    const resumed = await f.db.prepare("SELECT COUNT(*) count FROM external_models WHERE definition_key=? AND next_refresh_at IS NOT NULL").bind(f.model).first<any>();
    expect(resumed.count).toBe(21);
  });

  it("batches degraded metadata when 20 Provider endpoints are missing", async () => {
    const f = await fixture("external_missing_budget"); await f.authorize();
    await f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,'task','write','service','svc_synthetic')").bind(f.application).run();
    const created = await f.request(`/api/v1/spaces/${f.space}/models/task/records`, "POST", { name: "Synthetic source" });
    expect(created.status).toBe(201);
    const source = { kind: "record", modelKey: "task", recordId: (await created.json<any>()).data.id };
    const operations = Array.from({ length: 20 }, (_, i) => {
      const recordId = `rec_external_missing_${i}`; f.state.endpointErrors[recordId] = "EXTERNAL_RESOURCE_UNAVAILABLE";
      return { operation: "relation_create", source, predicate: "generated_from", target: { kind: "record", modelKey: f.model, recordId } };
    });
    f.metric.d1 = 0; f.state.calls = []; f.state.maxActive = 0;
    const result = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations });
    expect(result.status).toBe(200);
    expect((await result.json<any>()).data.items.every((item: any) => item.status === "failed" && item.error.code === "EXTERNAL_RESOURCE_UNAVAILABLE")).toBe(true);
    expect(f.metric.d1).toBeLessThanOrEqual(10);
    expect(f.state.calls.filter(call => call === "get")).toHaveLength(20);
    expect(f.state.maxActive).toBeLessThanOrEqual(3);
  });

  it("retired publication preserves history, origin and existing Native records", async () => {
    const f = await fixture("external_origin_history");
    expect((await f.request(`/api/v1/model-admin/models/${f.model}/retire`, "POST", {}, f.sourceAdmin)).status).toBe(204);
    const nativeDefinition = { definitionVersion: 1, key: f.model, display: { singular: "Record", plural: "Records" }, fields: { name: { type: "string" } }, access: ["read", "write"] };
    const validation = await f.request("/api/v1/model-admin/models/validate", "POST", { definition: nativeDefinition }, f.sourceAdmin);
    expect(validation.status).toBe(200);
    expect((await validation.json<any>()).data.valid).toBe(false);
    const switched = await f.request("/api/v1/model-admin/models", "POST", { definition: nativeDefinition, compatibility: "compatible" }, f.sourceAdmin);
    expect(switched.status).toBe(409);
    expect((await switched.json<any>()).error.code).toBe("MODEL_ORIGIN_IMMUTABLE");

    const nativeKey = "retired_native_history";
    const definition = { ...nativeDefinition, key: nativeKey };
    expect((await f.request("/api/v1/model-admin/models", "POST", { definition, compatibility: "initial" }, f.sourceAdmin)).status).toBe(201);
    await f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,'write','service','svc_synthetic')").bind(f.application, nativeKey).run();
    const path = `/api/v1/spaces/${f.space}/models/${nativeKey}/records`;
    const created = await f.request(path, "POST", { name: "Retained" }); expect(created.status).toBe(201);
    const recordId = (await created.json<any>()).data.id;
    expect((await f.request(`/api/v1/model-admin/models/${nativeKey}/retire`, "POST", {}, f.sourceAdmin)).status).toBe(204);
    const externalDefinition = { ...definition, origin: "external", fields: {} };
    const reverse = await f.request("/api/v1/model-admin/models", "POST", { definition: externalDefinition, compatibility: "compatible" }, f.sourceAdmin);
    expect(reverse.status).toBe(409); expect((await reverse.json<any>()).error.code).toBe("MODEL_ORIGIN_IMMUTABLE");
    expect((await f.request("/api/v1/model-admin/models", "POST", { definition, compatibility: "initial" }, f.sourceAdmin)).status).toBe(400);
    const resumed = await f.request("/api/v1/model-admin/models", "POST", { definition, compatibility: "compatible" }, f.sourceAdmin);
    expect(resumed.status).toBe(201); expect((await resumed.json<any>()).data.version).toBe(2);
    const retained = await f.request(`${path}/${recordId}`); expect(retained.status).toBe(200);
    expect((await retained.json<any>()).data.name).toBe("Retained");
  });

  it("rejects Provider identity substitution and preserves uncertain mutation outcomes", async () => {
    const f = await fixture(); await f.authorize();
    const target = "rec_external_expected";
    for (const id of ["rec_external_other", "rec_native_collision"]) {
      f.state.returnedRecordId = id;
      const read = await f.request(`${f.path}/${target}`);
      expect(read.status).toBe(502);
      expect((await read.json<any>()).error.code).toBe("EXTERNAL_CONTRACT_INVALID");
      const write = await f.request(`${f.path}/${target}`, "PATCH", { [field]: 9 });
      expect(write.status).toBe(502);
      expect((await write.json<any>()).error.code).toBe("EXTERNAL_WRITE_UNKNOWN");
      const removed = await f.request(`${f.path}/${target}`, "DELETE", {});
      expect(removed.status).toBe(502);
      expect((await removed.json<any>()).error.code).toBe("EXTERNAL_WRITE_UNKNOWN");
    }
    expect((await f.db.prepare("SELECT record_id FROM external_record_identities WHERE space_id=?").bind(f.space).all()).results).toEqual([]);
  });

  it("publishes an External definition without Native storage, binds it and uses the business key in CRUD/Batch", async () => {
    const f = await fixture("external_document_test"); await f.authorize();
    expect(f.model).toBe("external_document_test");
    const row = await f.db.prepare("SELECT definition_key,model_key FROM external_models WHERE space_id=?").bind(f.space).first<any>();
    expect(row.definition_key).toBe("external_document_test"); expect(row.model_key).toMatch(/^ext_/);
    expect((await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%external_document_test%'").all()).results).toEqual([]);
    const created = await f.request(f.path, "POST", { [field]: 4 });
    expect(created.status).toBe(201); const record = (await created.json<any>()).data;
    expect(record.modelKey).toBe("external_document_test");
    expect(record.origin).toBeUndefined();
    expect(record.schemaHash).toBeUndefined();
    expect(record.version).toBeUndefined();
    const queried = await f.request(`${f.path}/query`, "POST", {});
    expect(queried.status).toBe(200);
    const queriedRecord = (await queried.json<any>()).data.items[0];
    expect(queriedRecord.origin).toBeUndefined();
    expect(queriedRecord.schemaHash).toBeUndefined();
    f.state.calls = [];
    const result = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations: [{ operation: "create", modelKey: f.model, data: { [field]: 5 } }] });
    expect(result.status).toBe(200);
    const bulk = (await result.json<any>()).data;
    expect(bulk.bulkId).toMatch(/^blk_/);
    expect(bulk.items[0].status).toBe("succeeded");
    expect(f.state.calls).toEqual(["create"]);
    const duplicate = await f.request(`/api/v1/spaces/${f.space}/external-models`, "POST", { connectionId: f.source, definitionKey: f.model, resourceId: f.resource, declaredAccess: "write" });
    expect(duplicate.status).toBe(409);
  });

  it("links Native assessment to the bound External document and preserves authority/honest hydration", async () => {
    const f = await fixture("health_document"); await f.authorize();
    const published = await f.request("/api/v1/model-admin/models", "POST", { definition: { definitionVersion: 1, key: "health_assessment", display: { singular: "Assessment", plural: "Assessments" }, fields: { name: { type: "string" } }, access: ["read", "write"], semanticRelations: { outgoing: ["based_on"] } }, compatibility: "initial" }, f.sourceAdmin);
    expect(published.status).toBe(201);
    await f.db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?, 'health_assessment','write','service','svc_synthetic')").bind(f.application).run();
    const native = await f.request(`/api/v1/spaces/${f.space}/models/health_assessment/records`, "POST", { name: "Assessment" });
    expect(native.status).toBe(201); const sourceId = (await native.json<any>()).data.id;
    const targetId = "rec_external_evidence";
    const input = { source: { kind: "record", modelKey: "health_assessment", recordId: sourceId }, predicate: "based_on", target: { kind: "record", modelKey: f.model, recordId: targetId } };
    const base = `/api/v1/spaces/${f.space}/semantic-relations`;
    const created = await f.request(base, "POST", input); expect(created.status).toBe(200);
    const id = (await created.json<any>()).data.id;
    const hydrated = await f.request(`${base}/${id}?hydrate=both`); expect(hydrated.status).toBe(200);
    const edge = (await hydrated.json<any>()).data;
    expect(edge.targetRecord.origin).toBeUndefined();
    expect(edge.targetRecord.schemaHash).toBeUndefined();
    expect(edge.targetRecord.version).toBeUndefined();
    f.state.calls = [];
    const atomic = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { operations: [{ operation: "relation_create", ...input }] });
    expect(atomic.status).toBe(422); expect(f.state.calls).toEqual([]);
    const bulk = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations: [{ operation: "relation_create", ...input }] });
    expect(bulk.status).toBe(200); expect((await bulk.json<any>()).data.items[0].status).toBe("succeeded");
    const combined = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations: [
      { operation: "relation_create", source: input.source, predicate: "based_on", target: { kind: "record", modelKey: f.model, clientRef: "document" } },
      { operation: "create", modelKey: f.model, clientRef: "document", data: { [field]: 6 } },
    ] });
    expect(combined.status).toBe(200); expect((await combined.json<any>()).data.items.map((i: any) => i.status)).toEqual(["succeeded", "succeeded"]);
    f.metric.d1 = 0; f.state.calls = []; f.state.maxActive = 0;
    const twenty = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations: Array.from({ length: 20 }, (_, i) => ({ operation: "relation_create", ...input, target: { ...input.target, recordId: `rec_external_many_${i}` } })) });
    expect(twenty.status).toBe(200); const twentyData = (await twenty.json<any>()).data; expect(twentyData.items.every((i: any) => i.status === "succeeded")).toBe(true);
    expect(f.metric.d1).toBeLessThanOrEqual(10); expect(f.state.calls.filter(c => c === "get")).toHaveLength(20); expect(f.state.maxActive).toBeLessThanOrEqual(3);
    f.state.error = "EXTERNAL_UNAVAILABLE"; f.state.calls = [];
    const deleteBatch = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, operations: [{ operation: "relation_delete", relationId: twentyData.items[0].relationId }] });
    expect(deleteBatch.status).toBe(200); expect((await deleteBatch.json<any>()).data.items[0].status).toBe("succeeded"); expect(f.state.calls).toEqual([]); f.state.error = null;
    const externalEdge = await f.request(base, "POST", { source: { ...input.target, recordId: "rec_external_source" }, predicate: "relates_to", target: input.target });
    expect(externalEdge.status).toBe(200);
    const externalEdgeId = (await externalEdge.json<any>()).data.id;
    await f.db.prepare("UPDATE external_record_identities SET next_check_at='2000-01-01T00:00:00.000Z' WHERE record_id=? AND space_id=?").bind(targetId, f.space).run();
    f.state.error = "EXTERNAL_RESOURCE_UNAVAILABLE";
    await reconcileExternalModels(f.bindings);
    expect((await f.db.prepare("SELECT availability FROM external_record_identities WHERE record_id=?").bind(targetId).first<any>()).availability).toBe("unavailable");
    f.state.error = "EXTERNAL_RESOURCE_UNAVAILABLE";
    expect((await f.request(`${base}/${externalEdgeId}?hydrate=both`)).status).toBe(404);
    f.state.calls = [];
    expect((await f.request(`${base}/${externalEdgeId}`, "DELETE")).status).toBe(204); expect(f.state.calls).toEqual([]);
    f.state.error = null;
    expect((await f.request(`${f.path}/${targetId}`, "DELETE", {})).status).toBe(204);
    expect((await f.db.prepare("SELECT id FROM semantic_relations WHERE id=?").bind(id).all()).results).toEqual([]);
    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?").bind(f.application, f.model).run();
    f.state.calls = []; expect((await f.request(`${base}/${id}?hydrate=both`)).status).toBe(404); expect(f.state.calls).toEqual([]);
  });

  it("uses indexed executable refresh work; disabled connections do not occupy the queue and reactivation resumes", async () => {
    const f = await fixture();
    await f.db.prepare("UPDATE external_models SET next_refresh_at='2099-01-01T00:00:00.000Z'").run();
    await f.db.prepare("UPDATE external_sources SET status='disabled' WHERE id=?").bind(f.source).run();
    const rows = await f.db.prepare("SELECT next_refresh_at FROM external_models WHERE model_key=?").bind(f.registration).first<any>();
    expect(rows.next_refresh_at).toBeNull();
    await f.db.prepare("UPDATE external_sources SET status='active' WHERE id=?").bind(f.source).run();
    expect((await f.db.prepare("SELECT next_refresh_at FROM external_models WHERE model_key=?").bind(f.registration).first<any>()).next_refresh_at).not.toBeNull();
    f.state.calls = [];
    await reconcileExternalModels(f.bindings);
    // Identity observation shares the scheduler but is an independent queue; this test
    // asserts only that the due schema binding is discovered exactly once.
    expect(f.state.calls.filter(call => call === "discover")).toEqual(["discover"]);
    const plan = await f.db.prepare("EXPLAIN QUERY PLAN SELECT space_id,model_key FROM external_models m WHERE status!='disabled' AND next_refresh_at IS NOT NULL AND next_refresh_at<=? AND EXISTS(SELECT 1 FROM external_sources s WHERE s.id=m.source_id AND s.status='active') AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=m.space_id AND s.deleted_at IS NULL) ORDER BY next_refresh_at,model_key LIMIT 20").bind(new Date().toISOString()).all<any>();
    expect(plan.results.some(r => r.detail.includes("idx_external_refresh_due"))).toBe(true);
    expect(plan.results.some(r => r.detail.includes("TEMP B-TREE") || r.detail === "SCAN m")).toBe(false);
  });

  it("accepts External writes through unified non-atomic Batch and rejects atomic before Provider execution", async () => {
    const f = await fixture(); await f.authorize(); f.state.calls = [];
    const path = `/api/v1/spaces/${f.space}/models/batch`;
    const operations = [{ operation: "create", modelKey: f.model, data: { [field]: 3 } }];
    expect((await f.request(path, "POST", { operations })).status).toBe(422);
    expect(f.state.calls).toEqual([]);
    const response = await f.request(path, "POST", { atomicConsistency: false, operations });
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.items[0].status).toBe("succeeded");
    expect(f.state.calls).toEqual(["create"]);
  });

  it("applies one request-wide Delegation to every External Batch item and audit", async () => {
    const f = await fixture(); await f.authorize();
    const issued = await f.request(`/api/v1/spaces/${f.space}/delegations`, "POST", { actor: { type: "agent", id: "agt_synthetic" }, scope: { target: { type: "model", id: f.model }, maxAccess: "write" } });
    expect(issued.status).toBe(201);
    const delegationId = (await issued.json<any>()).data.id;
    const bearer = await f.token(f.user, "user", ["resources:write"], "agt_synthetic");
    const response = await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", { atomicConsistency: false, delegationId, operations: [1, 2].map(value => ({ operation: "create", modelKey: f.model, data: { [field]: value } })) }, bearer);
    expect(response.status).toBe(200);
    expect((await response.json<any>()).data.items.map((i: any) => i.status)).toEqual(["succeeded", "succeeded"]);
    const rows = await f.db.prepare("SELECT delegation_id FROM external_operation_audit WHERE model_key=? AND operation='create'").bind(f.registration).all<any>();
    expect(rows.results.map(r => r.delegation_id)).toEqual([delegationId, delegationId]);
  });

  it("requires existing application authority, hides credentials and never persists provider records", async () => {
    const f = await fixture();
    f.state.calls = [];
    expect((await f.request(f.path, "POST", { [field]: 3 })).status).toBe(403);
    expect(f.state.calls).toEqual([]);
    await f.authorize();
    const response = await f.request(f.path, "POST", { [field]: 3 });
    expect(response.status).toBe(201);
    const data = ((await response.json()) as any).data;
    expect(data.origin).toBeUndefined();
    expect(data.schemaHash).toBeUndefined();
    expect(data.version).toBeUndefined();
    expect(data.createdBy).toBeUndefined();
    expect(
      await f.db
        .prepare("SELECT id FROM resource_records WHERE model_key=?")
        .bind(f.model)
        .first(),
    ).toBeNull();
    const audit = await f.db
      .prepare("SELECT * FROM external_operation_audit WHERE model_key=?")
      .bind(f.registration)
      .first<any>();
    expect(audit.result).toBe("succeeded");
    expect(audit.principal_id).toBe(f.user);
    expect(JSON.stringify(audit)).not.toContain(shared);
    const connections = await f.request(
      `/api/v1/spaces/${f.space}/external-connections`,
    );
    const connectionPayload = JSON.stringify(await connections.json());
    expect(connectionPayload).not.toContain(f.providerToken);
    expect(connectionPayload).not.toContain("credentialRef");
  });

  it("projects Space-local detail/inventory with honest capabilities and opaque unavailable elsewhere", async () => {
    const f = await fixture();
    await f.authorize();
    f.state.calls = [];
    const d = (
      (await (
        await f.request(`/api/v1/spaces/${f.space}/_discovery`)
      ).json()) as any
    ).data.models.find((m: any) => m.key === f.model);
    expect(d.origin).toBe("external");
    expect(d.version).toBeUndefined();
    expect(d.runtimeCapabilities.atomicBatch).toBe(false);
    expect(d.fields[0].sourceFieldId).toBeUndefined();
    const inventory = (
      (await (await f.request("/api/v1/me/_discovery/inventory")).json()) as any
    ).data;
    expect(inventory.models.find((m: any) => m.key === f.model).spaceId).toBe(
      f.space,
    );
    expect(
      (await f.request(`/api/v1/spaces/spc_other/_discovery/models/${f.model}`))
        .status,
    ).toBe(404);
    expect(f.state.calls).toEqual([]);
  });

  it("keeps resource uniqueness and restores a disabled registration identity", async () => {
    const f = await fixture();
    expect(
      (
        await f.request(`/api/v1/spaces/${f.space}/external-models`, "POST", {
          connectionId: f.source,
          definitionKey: f.model,
          resourceId: f.resource,
          declaredAccess: "write",
        })
      ).status,
    ).toBe(409);
    await f.request(
      `/api/v1/spaces/${f.space}/external-models/${f.model}`,
      "PATCH",
      { status: "disabled" },
    );
    const restored = await f.request(
      `/api/v1/spaces/${f.space}/external-models`,
      "POST",
      { connectionId: f.source, definitionKey: f.model, resourceId: f.resource, declaredAccess: "write" },
    );
    expect(((await restored.json()) as any).data.key).toBe(f.model);
  });

  it("enforces current membership and connection revocation before Provider I/O", async () => {
    const f = await fixture();
    await f.authorize();
    expect((await f.request(f.path)).status).toBe(200);
    await f.db
      .prepare("UPDATE space_memberships SET deleted_at=? WHERE space_id=?")
      .bind(new Date().toISOString(), f.space)
      .run();
    f.state.calls = [];
    expect((await f.request(f.path)).status).toBe(403);
    expect(f.state.calls).toEqual([]);
    await f.db
      .prepare("UPDATE space_memberships SET deleted_at=NULL WHERE space_id=?")
      .bind(f.space)
      .run();
    expect((await f.request(
      `/api/v1/spaces/${f.space}/external-connections/${f.source}`,
      "DELETE",
    )).status).toBe(204);
    f.state.calls = [];
    expect((await f.request(f.path)).status).toBe(404);
    expect(f.state.calls).toEqual([]);
  });

  it("adopts latest type/rename and rejects old query/cursor without coercion", async () => {
    const f = await fixture();
    await f.authorize();
    f.state.cursor = "provider_cursor";
    const first = (
      (await (
        await f.request(f.path + "/query", "POST", { page: { limit: 20 } })
      ).json()) as any
    ).data;
    expect(typeof first.nextCursor).toBe("string");
    f.state.type = "text";
    f.state.title = "Renamed";
    const refresh = await f.request(
      `/api/v1/spaces/${f.space}/external-models/${f.model}/refresh`,
      "POST",
      {},
    );
    expect(refresh.status).toBe(200);
    const detail = ((await refresh.json()) as any).data;
    expect(detail.fields[0].key).toBe(field);
    expect(detail.fields[0].type).toBe("text");
    f.state.calls = [];
    expect(
      (
        await f.request(f.path + "/query", "POST", {
          filter: { field, op: "gt", value: 2 },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await f.request(f.path + "/query", "POST", {
          page: { limit: 20, cursor: first.nextCursor },
        })
      ).status,
    ).toBe(400);
    expect(f.state.calls).toEqual([]);
  });

  it("refreshes/retries once on safe schema mismatch and never retries uncertain write", async () => {
    const f = await fixture();
    await f.authorize();
    f.state.calls = [];
    f.state.mismatch = 1;
    expect((await f.request(f.path)).status).toBe(200);
    expect(f.state.calls).toEqual(["query", "discover", "query"]);
    f.state.error = "EXTERNAL_WRITE_UNKNOWN";
    f.state.calls = [];
    expect((await f.request(f.path, "POST", { [field]: 3 })).status).toBe(502);
    expect(f.state.calls).toEqual(["create"]);
    expect(
      (await f.db
        .prepare(
          "SELECT result FROM external_operation_audit WHERE model_key=? AND operation='create'",
        )
        .bind(f.registration)
        .first<any>())!.result,
    ).toBe("unknown");
  });

  it("rejects version/action/atomic semantics before any Provider write", async () => {
    const f = await fixture();
    await f.authorize();
    f.state.calls = [];
    expect(
      (
        await f.request(f.path + "/rec_example", "PATCH", {
          version: 1,
          [field]: 2,
        })
      ).status,
    ).toBe(422);
    expect(
      (await f.request(f.path + "/rec_example/actions/do", "POST", {})).status,
    ).toBe(405);
    expect(
      (
        await f.request(`/api/v1/spaces/${f.space}/models/batch`, "POST", {
          operations: [
            { operation: "create", modelKey: f.model, data: { [field]: 2 } },
          ],
        })
      ).status,
    ).toBe(422);
    expect(f.state.calls).toEqual([]);
  });

  it("20 item bulk uses bounded fan-out, partial results and no Native version", async () => {
    const f = await fixture();
    await f.authorize();
    f.state.calls = [];
    f.metric.d1 = 0;
    const operations = Array.from({ length: 20 }, (_, i) => ({
      operation: "create",
      modelKey: f.model,
      data: i === 3 ? { unknown: 2 } : { [field]: i },
    }));
    const response = await f.request(
      `/api/v1/spaces/${f.space}/models/bulk`,
      "POST",
      { operations },
    );
    expect(response.status).toBe(200);
    const data = ((await response.json()) as any).data;
    expect(
      data.items.filter((i: any) => i.status === "succeeded"),
    ).toHaveLength(19);
    expect(data.items[3].status).toBe("failed");
    expect(data.items[0].version).toBeUndefined();
    expect(f.state.calls).toHaveLength(19);
    expect(f.state.maxActive).toBeLessThanOrEqual(3);
    expect(f.metric.d1).toBe(4);
  });

  it("single-use external delegated writes fail closed", async () => {
    const f = await fixture();
    await f.authorize();
    const agent = "agt_synthetic";
    const issue = await f.request(
      `/api/v1/spaces/${f.space}/delegations`,
      "POST",
      {
        actor: { type: "agent", id: agent },
        scope: { target: { type: "model", id: f.model }, maxAccess: "write" },
        constraints: { maxUses: 1 },
      },
    );
    expect(issue.status).toBe(201);
    const delegation = ((await issue.json()) as any).data.id;
    const delegated = await f.token(f.user, "user", ["resources:write"], agent);
    f.state.calls = [];
    expect(
      (
        await f.request(f.path, "POST", { [field]: 2 }, delegated, {
          "x-lifespace-delegation-id": delegation,
        })
      ).status,
    ).toBe(422);
    expect(f.state.calls).toEqual([]);
  });

  it("records local synthetic latency and structural costs separately from live Provider SLA", async () => {
    const f = await fixture();
    await f.authorize();
    const scenarios = [
      {
        name: "Get",
        path: f.path + "/rec_external_synthetic",
        method: "GET",
        input: undefined,
        adapterCalls: 1,
        d1: 5,
      },
      {
        name: "Query",
        path: f.path + "/query",
        method: "POST",
        input: { page: { limit: 20 } },
        adapterCalls: 1,
        d1: 5,
      },
      {
        name: "Create",
        path: f.path,
        method: "POST",
        input: { [field]: 2 },
        adapterCalls: 1,
        d1: 5,
      },
      {
        name: "Update",
        path: f.path + "/rec_external_synthetic",
        method: "PATCH",
        input: { [field]: 2 },
        adapterCalls: 1,
        d1: 5,
      },
      {
        name: "Batch20",
        path: `/api/v1/spaces/${f.space}/models/bulk`,
        method: "POST",
        input: {
          operations: Array.from({ length: 20 }, () => ({
            operation: "create",
            modelKey: f.model,
            data: { [field]: 2 },
          })),
        },
        adapterCalls: 20,
        d1: 4,
      },
    ];
    for (const scenario of scenarios) {
      const durations: number[] = [];
      for (let i = 0; i < 10; i++) {
        f.state.calls = [];
        f.metric.d1 = 0;
        const started = performance.now();
        const response = await f.request(
          scenario.path,
          scenario.method,
          scenario.input,
        );
        expect(response.status).toBe(scenario.name === "Create" ? 201 : 200);
        durations.push(performance.now() - started);
        expect(f.state.calls.length).toBe(scenario.adapterCalls);
        expect(f.metric.d1).toBe(scenario.d1);
        expect(f.state.calls).not.toContain("discover");
      }
      durations.sort((a, b) => a - b);
      console.log(
        "EXTERNAL_SYNTHETIC_COST",
        JSON.stringify({
          scenario: scenario.name,
          samples: 10,
          p50Ms: durations[4],
          p95Ms: durations[9],
          coreD1Rtt: scenario.d1,
          coreAdapterCalls: scenario.adapterCalls,
          providerCalls: "mocked; see independent Adapter contract tests",
          rows: scenario.name === "Batch20" ? 20 : 1,
        }),
      );
    }
  });

  it("rejects caller-owned credentialRef injection", async () => {
    const f = await fixture();
    f.state.calls = [];
    const response = await f.request(
      `/api/v1/spaces/${f.space}/external-connections`,
      "POST",
      {
        providerKey: "synthetic",
        displayName: "Injected",
        credential: { type: "bearer_token", token: "another-secret" },
        access: "read",
        credentialRef: "cnx_caller_controlled",
      },
    );
    expect(response.status).toBe(400);
    expect(f.state.calls).toEqual([]);
  });

  it("existing model Data Grant and application revocation govern Service reads", async () => {
    const f = await fixture();
    await f.authorize();
    const service = "svc_grantee";
    const granted = await f.request(
      `/api/v1/spaces/${f.space}/grants`,
      "POST",
      {
        granteeType: "service",
        granteeId: service,
        resourceType: "model",
        resourceId: f.model,
        permission: "read",
      },
    );
    expect(granted.status).toBe(201);
    const credential = await f.token(service, "service", ["resources:read"]);
    f.state.calls = [];
    expect((await f.request(f.path, "GET", undefined, credential)).status).toBe(
      200,
    );
    await f.db
      .prepare(
        "DELETE FROM application_model_access WHERE application_id=? AND model_key=?",
      )
      .bind(f.application, f.model)
      .run();
    f.state.calls = [];
    expect((await f.request(f.path, "GET", undefined, credential)).status).toBe(
      403,
    );
    expect(f.state.calls).toEqual([]);
  });

  it("known External identity works with existing record Delegation and opaque collection denial", async () => {
    const f = await fixture();
    await f.authorize();
    const created = (
      (await (await f.request(f.path, "POST", { [field]: 2 })).json()) as any
    ).data;
    const issue = await f.request(
      `/api/v1/spaces/${f.space}/delegations`,
      "POST",
      {
        actor: { type: "agent", id: "agt_synthetic" },
        scope: {
          target: { type: "record", id: created.id },
          maxAccess: "read",
        },
        constraints: { maxUses: 1 },
      },
    );
    expect(issue.status).toBe(201);
    const dlg = ((await issue.json()) as any).data.id;
    const token = await f.token(
      f.user,
      "user",
      ["resources:read"],
      "agt_synthetic",
    );
    const header = { "x-lifespace-delegation-id": dlg };
    f.state.calls = [];
    expect(
      (await f.request(f.path, "GET", undefined, token, header)).status,
    ).toBe(403);
    expect(f.state.calls).toEqual([]);
    expect(
      (
        await f.request(
          f.path + "/" + created.id,
          "GET",
          undefined,
          token,
          header,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          f.path + "/" + created.id,
          "GET",
          undefined,
          token,
          header,
        )
      ).status,
    ).toBe(403);
  });

  it("uses one Native batch alongside External partial items without a distributed transaction claim", async () => {
    const f = await fixture();
    await f.authorize();
    await f.db
      .prepare(
        "INSERT OR REPLACE INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)",
      )
      .bind(f.application, "task", "write", "service", "svc_synthetic")
      .run();
    const response = await f.request(
      `/api/v1/spaces/${f.space}/models/bulk`,
      "POST",
      {
        operations: [
          {
            operation: "create",
            modelKey: "task",
            data: { name: "Synthetic task" },
          },
          { operation: "create", modelKey: f.model, data: { [field]: 2 } },
        ],
      },
    );
    expect(response.status).toBe(200);
    const data = ((await response.json()) as any).data;
    expect(data.items.map((x: any) => x.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(data.nativeBulkId).toMatch(/^blk_/);
    expect(data.items[0].version).toBe(1);
    expect(data.items[1].version).toBeUndefined();
  });

  it("preserves committed Native results when External pending audit fails, without Provider execution", async () => {
    const f = await fixture();
    await f.authorize();
    await f.db
      .prepare(
        "INSERT OR REPLACE INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?)",
      )
      .bind(f.application, "task", "write", "service", "svc_synthetic")
      .run();
    f.state.calls = [];
    f.state.failAudit = true;
    const response = await f.request(
      `/api/v1/spaces/${f.space}/models/bulk`,
      "POST",
      {
        operations: [
          {
            operation: "create",
            modelKey: "task",
            data: { name: "Synthetic audit failure task" },
          },
          { operation: "create", modelKey: f.model, data: { [field]: 2 } },
        ],
      },
    );
    expect(response.status).toBe(200);
    const data = ((await response.json()) as any).data;
    expect(data.items.map((x: any) => x.status)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect(data.items[1].error.code).toBe("EXTERNAL_AUDIT_UNAVAILABLE");
    expect(f.state.calls).toEqual([]);
  });

  it("keeps the retired static Source routes absent", async () => {
    const f = await fixture();
    expect((await f.request(`/api/v1/spaces/${f.space}/external-sources`)).status).toBe(404);
    expect((await f.request(
      "/api/v1/model-admin/external-sources",
      "POST",
      { spaceId: f.space, providerKey: "synthetic", credentialRef: "cnx_static" },
      f.sourceAdmin,
    )).status).toBe(404);
  });
});

import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, it, expect } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";
const field = "f_" + "a".repeat(32),
  shared = "synthetic-external-shared-secret-at-least-32-chars";
const pem = (label: string, bytes: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${btoa(
    String.fromCharCode(...new Uint8Array(bytes)),
  )
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END ${label}-----`;
async function fixture() {
  const db = (env as unknown as { DB: D1Database }).DB,
    app = createApp(),
    suffix = crypto.randomUUID().replaceAll("-", "");
  const space = "spc_" + suffix,
    user = "usr_" + suffix,
    application = "app_" + suffix,
    resource = "synthetic_resource_" + suffix;
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
    id,
    data: { [field]: state.type === "number" ? 8 : "eight" },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const binding = {
    async fetch(url: RequestInfo | URL, init?: RequestInit) {
      const req = new Request(url, init);
      expect(req.headers.get("x-lifespace-internal-secret")).toBe(shared);
      const r = (await req.json()) as { operation: string; recordId?: string };
      state.calls.push(r.operation);
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      await Promise.resolve();
      state.active--;
      if (state.error)
        return Response.json(
          {
            contractVersion: 1,
            error: { code: state.error, retrySafe: false },
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
                ? { id: r.recordId }
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
    EXTERNAL_ADAPTER: binding,
    EXTERNAL_ADAPTER_SHARED_SECRET: shared,
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
  const sr = await request(
    "/api/v1/model-admin/external-sources",
    "POST",
    { spaceId: space, providerKey: "synthetic", credentialRef: "test_ref" },
    sourceAdmin,
  );
  expect(sr.status).toBe(201);
  const source = ((await sr.json()) as any).data.id;
  const mr = await request(`/api/v1/spaces/${space}/external-models`, "POST", {
    sourceId: source,
    resourceId: resource,
    declaredAccess: "write",
  });
  expect(mr.status).toBe(201);
  const model = ((await mr.json()) as any).data.key;
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
    model,
    path,
    state,
    metric,
    bindings,
    request,
    token,
    resource,
    authorize,
  };
}
describe("Space-local External Model framework", () => {
  it("requires existing application authority, hides credentials and never persists provider records", async () => {
    const f = await fixture();
    f.state.calls = [];
    expect((await f.request(f.path, "POST", { [field]: 3 })).status).toBe(403);
    expect(f.state.calls).toEqual([]);
    await f.authorize();
    const response = await f.request(f.path, "POST", { [field]: 3 });
    expect(response.status).toBe(201);
    const data = ((await response.json()) as any).data;
    expect(data.origin).toBe("external");
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
      .bind(f.model)
      .first<any>();
    expect(audit.result).toBe("succeeded");
    expect(audit.principal_id).toBe(f.user);
    expect(JSON.stringify(audit)).not.toContain(shared);
    const sources = await f.request(
      `/api/v1/spaces/${f.space}/external-sources`,
    );
    expect(JSON.stringify(await sources.json())).not.toContain("test_ref");
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
          sourceId: f.source,
          resourceId: f.resource,
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
      { sourceId: f.source, resourceId: f.resource },
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
    await f.request(
      `/api/v1/spaces/${f.space}/external-sources/${f.source}`,
      "PATCH",
      { status: "disabled" },
    );
    expect((await f.request(f.path)).status).toBe(404);
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
        .bind(f.model)
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
        path: f.path + "/rec_synthetic",
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
        path: f.path + "/rec_synthetic",
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
  it("does not let a User provision a connection by guessing a Secret reference", async () => {
    const f = await fixture();
    f.state.calls = [];
    const response = await f.request(
      "/api/v1/model-admin/external-sources",
      "POST",
      { spaceId: f.space, providerKey: "synthetic", credentialRef: "test_ref" },
      await f.token(f.user, "user", ["models:manage"]),
    );
    expect(response.status).toBe(403);
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
});

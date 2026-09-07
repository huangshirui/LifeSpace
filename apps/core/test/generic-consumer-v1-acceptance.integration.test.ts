import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Evidence = {
  method: string;
  path: string;
  requestBytes: number;
  responseBytes: number;
  status: number;
};
type JsonResult = {
  status: number;
  data?: any;
  error?: any;
  bytes: number;
};

type Fixture = {
  db: D1Database;
  publicKey: string;
  accessToken: string;
  clientId: string;
  spaceId: string;
  targetModelKey: string;
  unrelatedModelKey: string;
};

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function userToken(privateKey: string, userId: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function replacePath(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (path, [key, value]) => path.replace(`{${key}}`, encodeURIComponent(value)),
    template,
  );
}

class GenericConsumer {
  readonly evidence: Evidence[] = [];
  private readonly app = createApp();
  private readonly encoder = new TextEncoder();

  constructor(
    private readonly publicKey: string,
    private readonly accessToken: string,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<JsonResult> {
    const requestText = body === undefined ? "" : JSON.stringify(body);
    const response = await this.app.request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: requestText }),
    }, {
      DB: (env as unknown as TestEnv).DB,
      IDENTITY_PUBLIC_KEY: this.publicKey,
      ENVIRONMENT: "test",
    });
    const responseText = await response.text();
    this.evidence.push({
      method,
      path,
      requestBytes: this.encoder.encode(requestText).byteLength,
      responseBytes: this.encoder.encode(responseText).byteLength,
      status: response.status,
    });
    const payload = responseText ? JSON.parse(responseText) : {};
    return {
      status: response.status,
      data: payload.data,
      error: payload.error,
      bytes: this.encoder.encode(responseText).byteLength,
    };
  }

  async loadSelectedModel(targetModelKey: string) {
    const inventory = await this.call("GET", "/api/v1/me/_discovery/inventory");
    expect(inventory.status).toBe(200);
    const identity = inventory.data.models.find((model: any) => model.key === targetModelKey);
    expect(identity).toBeTruthy();
    const space = inventory.data.spaces.find((candidate: any) =>
      candidate.models.some((edge: any) => edge.modelKey === targetModelKey));
    expect(space).toBeTruthy();
    const edge = space.models.find((candidate: any) => candidate.modelKey === targetModelKey);
    expect(edge.access).toContain("write");

    const detailPath = replacePath(inventory.data.semanticDetailPathTemplate, {
      spaceId: space.spaceId,
      modelKey: targetModelKey,
    });
    const detail = await this.call("GET", detailPath);
    expect(detail.status).toBe(200);
    expect({
      key: detail.data.key,
      route: detail.data.route,
      version: detail.data.version,
      schemaHash: detail.data.schemaHash,
    }).toEqual({
      key: identity.key,
      route: identity.route,
      version: identity.version,
      schemaHash: identity.schemaHash,
    });
    return { inventory: inventory.data, identity, space, detail: detail.data };
  }

  private scalarValue(field: any): unknown {
    switch (field.type) {
      case "string": return `${field.title ?? field.key} value`;
      case "text": return `${field.title ?? field.key} text`;
      case "integer": return field.minimum ?? 1;
      case "number": return field.minimum ?? 1.5;
      case "boolean": return false;
      case "date": return "2026-09-15";
      case "datetime": return "2026-09-15T09:30:00.000Z";
      case "timezone": return "UTC";
      case "enum": return field.values?.[0];
      default: throw new Error(`No generic scalar value strategy for field type ${field.type}`);
    }
  }

  private async relationValue(spaceId: string, modelKey: string, field: any) {
    const lookupPath = `/api/v1/spaces/${encodeURIComponent(spaceId)}`
      + `/_relation-targets/${encodeURIComponent(modelKey)}/${encodeURIComponent(field.key)}?limit=10`;
    const lookup = await this.call("GET", lookupPath);
    expect(lookup.status).toBe(200);
    expect(lookup.data.items.length).toBeGreaterThan(0);
    const selected = lookup.data.items[0];
    return {
      value: field.relation.cardinality === "many" ? [selected.id] : selected.id,
      selected,
    };
  }

  async deriveCreateInput(spaceId: string, detail: any) {
    const body: Record<string, unknown> = {};
    const selectedRelations = new Map<string, { id: string; label: string }>();

    for (const field of detail.fields) {
      if (field.readOnly) continue;
      if (Object.prototype.hasOwnProperty.call(detail.defaults, field.key)) continue;
      if (!field.required) continue;
      if (field.relation) {
        const relation = await this.relationValue(spaceId, detail.key, field);
        body[field.key] = relation.value;
        selectedRelations.set(field.key, relation.selected);
      } else {
        body[field.key] = this.scalarValue(field);
      }
    }
    return { body, selectedRelations };
  }

  async create(spaceId: string, detail: any, body: Record<string, unknown>) {
    return this.call("POST", `/api/v1/spaces/${encodeURIComponent(spaceId)}/${detail.route}`, body);
  }

  async queryForCreatedRecord(spaceId: string, detail: any, record: any) {
    const filter = detail.query.filters.find((candidate: any) => record[candidate.field] !== undefined);
    expect(filter).toBeTruthy();
    const value = record[filter.field];
    const queryValue = Array.isArray(value) ? value.join(",") : String(value);
    const limit = detail.query.pagination.limit.default;
    const path = `/api/v1/spaces/${encodeURIComponent(spaceId)}/${detail.route}`
      + `?${encodeURIComponent(filter.parameter)}=${encodeURIComponent(queryValue)}`
      + `&${encodeURIComponent(detail.query.pagination.limit.parameter)}=${encodeURIComponent(String(limit))}`;
    return this.call("GET", path);
  }

  async executeFirstAction(spaceId: string, detail: any, record: any) {
    const action = detail.actions[0];
    expect(action).toBeTruthy();
    const body: Record<string, unknown> = {};
    for (const field of action.input.fields) {
      if (field.required) body[field.key] = this.scalarValue(field);
    }
    if (action.concurrency?.required) {
      body[action.concurrency.transport.name] = record.version;
    }
    const path = replacePath(action.invocation.pathTemplate, {
      spaceId,
      recordId: record.id,
      modelKey: detail.key,
    });
    return this.call(action.invocation.method, path, body);
  }

  async resolveHeldRelation(spaceId: string, detail: any, fieldKey: string, id: string) {
    const field = detail.fields.find((candidate: any) => candidate.key === fieldKey);
    const resolution = field?.relation?.resolution;
    expect(resolution?.supported).toBe(true);
    const path = replacePath(resolution.pathTemplate, {
      spaceId,
      modelKey: detail.key,
      fieldKey,
    });
    return this.call(resolution.method, path, { ids: [id, id] });
  }
}

async function fixture(): Promise<Fixture> {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const short = suffix.slice(0, 8);
  const userId = `usr_m4_${suffix}`;
  const clientId = `app_m4_${suffix}`;
  const spaceId = `spc_m4_${suffix}`;
  const targetModelKey = `acceptance_card_${short}`;
  const unrelatedModelKey = `acceptance_blob_${short}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "M4 Acceptance", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_m4_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_m4_owner_${suffix}`, spaceId, userId, "Zulu Owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_m4_alpha_${suffix}`, spaceId, null, "Alpha Collaborator", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_m4_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_m4_admin_${suffix}`,
  };

  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: targetModelKey,
    route: `acceptance-cards-${short}`,
    display: { singular: "Acceptance Card", plural: "Acceptance Cards" },
    description: "Synthetic unfamiliar model for generic-consumer acceptance only.",
    fields: {
      headline: { type: "string", title: "Headline", required: true, minLength: 1, maxLength: 120 },
      status: { type: "enum", title: "Status", required: true, readOnly: true, values: ["open", "finished"] },
      dueDate: { type: "date", title: "Due Date", required: true },
      ownerPersonId: { type: "person", title: "Owner", required: true },
      note: { type: "text", title: "Note", nullable: true, maxLength: 1000 },
    },
    defaults: { status: "open" },
    query: {
      searchable: ["headline", "note"],
      filterable: ["status", "dueDate", "ownerPersonId"],
      sortable: ["dueDate", "headline"],
    },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
    actions: {
      finish: {
        access: "write",
        guards: [{ field: "status", op: "neq", value: "finished" }],
        set: { status: "finished" },
      },
    },
  }, "initial");

  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: unrelatedModelKey,
    route: `acceptance-blobs-${short}`,
    display: { singular: "Acceptance Blob", plural: "Acceptance Blobs" },
    description: "Unrelated model whose detail must not be fetched by the local consumer task.",
    fields: {
      payload: { type: "text", title: "Payload", required: true, maxLength: 2000 },
      category: { type: "enum", title: "Category", required: true, values: ["a", "b", "c"] },
    },
    defaults: { category: "a" },
    query: { searchable: ["payload"], filterable: ["category"], sortable: [] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");

  await db.batch([
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, targetModelKey, "write", "service", "svc_test_admin"),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, unrelatedModelKey, "write", "service", "svc_test_admin"),
  ]);

  return {
    db,
    publicKey,
    accessToken: await userToken(privateKey, userId, clientId),
    clientId,
    spaceId,
    targetModelKey,
    unrelatedModelKey,
  };
}

describe("#165 M4 Generic Consumer v1 acceptance", () => {
  it("uses progressive semantics to operate an unfamiliar model and stale projection cannot restore revoked authority", async () => {
    const f = await fixture();
    const consumer = new GenericConsumer(f.publicKey, f.accessToken);

    const selected = await consumer.loadSelectedModel(f.targetModelKey);
    expect(selected.inventory.models.map((model: any) => model.key).sort()).toEqual([
      f.targetModelKey,
      f.unrelatedModelKey,
    ].sort());

    const derived = await consumer.deriveCreateInput(f.spaceId, selected.detail);
    const requiredWritableWithoutDefaults = selected.detail.fields
      .filter((field: any) => field.required && !field.readOnly
        && !Object.prototype.hasOwnProperty.call(selected.detail.defaults, field.key))
      .map((field: any) => field.key)
      .sort();
    expect(Object.keys(derived.body).sort()).toEqual(requiredWritableWithoutDefaults);

    const created = await consumer.create(f.spaceId, selected.detail, derived.body);
    expect(created.status).toBe(201);
    expect(created.data.id).toBeTypeOf("string");
    expect(created.data.version).toBe(1);
    for (const [key, value] of Object.entries(selected.detail.defaults)) {
      expect(derived.body).not.toHaveProperty(key);
      expect(created.data[key]).toEqual(value);
    }

    const queried = await consumer.queryForCreatedRecord(f.spaceId, selected.detail, created.data);
    expect(queried.status).toBe(200);
    expect(queried.data.items.map((record: any) => record.id)).toContain(created.data.id);

    const acted = await consumer.executeFirstAction(f.spaceId, selected.detail, created.data);
    expect(acted.status).toBe(200);
    expect(acted.data.id).toBe(created.data.id);
    expect(acted.data.version).toBeGreaterThan(created.data.version);

    const relationEntry = [...derived.selectedRelations.entries()][0];
    expect(relationEntry).toBeTruthy();
    const [relationFieldKey, selectedReference] = relationEntry;
    const resolved = await consumer.resolveHeldRelation(
      f.spaceId,
      selected.detail,
      relationFieldKey,
      selectedReference.id,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.data.items).toEqual([
      { id: selectedReference.id, status: "resolved", label: selectedReference.label },
      { id: selectedReference.id, status: "resolved", label: selectedReference.label },
    ]);

    await f.db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?")
      .bind(f.clientId, f.targetModelKey).run();
    const deniedFromStaleProjection = await consumer.create(f.spaceId, selected.detail, derived.body);
    expect(deniedFromStaleProjection.status).toBe(403);
    expect(deniedFromStaleProjection.error?.code).toBe("FORBIDDEN");

    const paths = consumer.evidence.map((entry) => entry.path);
    expect(paths.filter((path) => path === "/api/v1/me/_discovery/inventory")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/v1/me/_discovery")).toHaveLength(0);
    expect(paths.filter((path) => path.includes("/_discovery/models/"))).toHaveLength(1);
    expect(paths.some((path) => path.includes(`/_discovery/models/${f.unrelatedModelKey}`))).toBe(false);
    expect(paths.filter((path) => path.includes("/_relation-targets/"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("/_reference-resolutions/"))).toHaveLength(1);

    const payloadByKind = Object.fromEntries(consumer.evidence.map((entry, index) => [
      `${index + 1}:${entry.method}:${entry.path.split("?")[0]}`,
      { requestBytes: entry.requestBytes, responseBytes: entry.responseBytes, status: entry.status },
    ]));
    console.log("M4_GENERIC_CONSUMER_ACCEPTANCE", JSON.stringify({
      targetModelCountInInventory: selected.inventory.models.length,
      selectedDetailRequests: 1,
      fullAggregateDiscoveryRequests: 0,
      relationLookupRequests: 1,
      referenceResolutionRequests: 1,
      totalHttpRequests: consumer.evidence.length,
      payloadByKind,
    }));
  }, 20_000);
});

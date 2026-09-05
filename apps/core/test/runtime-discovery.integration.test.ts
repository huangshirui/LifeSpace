import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

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

async function token(
  privateKey: string,
  principalType: "user" | "service",
  principalId: string,
  clientId: string,
  scopes: string[],
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, accessToken: string, path: string) {
  return createApp().request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_${suffix}`;
  const serviceId = `svc_${suffix}`;
  const clientId = `app_discovery_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const modelKey = `discovery_note_${suffix.slice(0, 8)}`;
  const route = `discovery-notes-${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Discovery Test", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, spaceId, userId, "Discovery Tester", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_publisher_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: modelKey,
    route,
    display: { singular: "Discovery Note", plural: "Discovery Notes" },
    fields: {
      title: { type: "string", title: "Title", description: "Note title", required: true, minLength: 1, maxLength: 120 },
      status: { type: "enum", title: "Status", description: "Note state", required: true, values: ["open", "done"] },
    },
    defaults: { status: "open" },
    query: { searchable: ["title"], filterable: ["status"], sortable: ["title"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
    actions: {
      complete: {
        access: "write",
        guards: [{ field: "status", op: "neq", value: "done" }],
        set: { status: "done" },
      },
    },
  }, "initial");

  await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", "svc_test_admin").run();

  return { db, privateKey, publicKey, userId, serviceId, clientId, spaceId, modelKey, route, now };
}

type DiscoveredAction = {
  key: string;
  access: string;
  kind: string;
  input: { fields: Array<{ key: string; type: string; title?: string; required?: boolean; minimum?: number }> };
  concurrency: {
    strategy: string;
    required: boolean;
    transport: { in: string; name: string };
  };
};

type DiscoveredQuery = {
  searchable: string[];
  filterable: string[];
  sortable: string[];
  sort: {
    parameter: string;
    syntax: string;
    repeatable: boolean;
    ordered: boolean;
    maxCriteria: number;
    default: string[];
    envelopeFields: string[];
  };
};

describe("Runtime discovery", () => {
  it("returns effective user-authorized model metadata with canonical field titles, ordered sort semantics and separated concurrency", async () => {
    const f = await fixture();
    const accessToken = await token(
      f.privateKey,
      "user",
      f.userId,
      f.clientId,
      ["resources:read", "resources:write"],
    );

    const response = await request(f.publicKey, accessToken, `/api/v1/spaces/${f.spaceId}/_discovery`);
    expect(response.status).toBe(200);
    const payload = await response.json<{ data: { spaceName: string | null; models: Array<{
      key: string;
      route: string;
      access: string[];
      defaults: Record<string, unknown>;
      fields: Array<{ key: string; type: string; title?: string; description?: string }>;
      query: DiscoveredQuery;
      actions: DiscoveredAction[];
    }> } }>();
    expect(payload.data.spaceName).toBe("Discovery Test");
    const model = payload.data.models.find((entry) => entry.key === f.modelKey);
    expect(model).toMatchObject({
      key: f.modelKey,
      route: f.route,
      access: ["read", "write"],
      defaults: { status: "open" },
    });
    expect(model?.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "title", type: "string", title: "Title", description: "Note title" }),
      expect.objectContaining({ key: "status", type: "enum", title: "Status", description: "Note state" }),
    ]));
    expect(model?.query.sort).toEqual({
      parameter: "sort",
      syntax: "field:direction",
      repeatable: true,
      ordered: true,
      maxCriteria: 8,
      default: ["createdAt:desc"],
      envelopeFields: ["createdAt", "updatedAt"],
    });
    expect(model?.actions).toContainEqual({
      key: "complete",
      access: "write",
      kind: "workflow",
      input: { fields: [] },
      concurrency: {
        strategy: "record-version",
        required: true,
        transport: { in: "body", name: "version" },
      },
    });
  });

  it("exposes capability domain input titles separately from the same record-version concurrency metadata", async () => {
    const db = (env as unknown as TestEnv).DB;
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_${suffix}`;
    const clientId = `app_temporal_discovery_${suffix}`;
    const spaceId = `spc_${suffix}`;
    const now = new Date().toISOString();
    await db.batch([
      db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Temporal Discovery", userId, now, now, "UTC"),
      db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, spaceId, userId, "Temporal Tester", now, now),
      db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
        VALUES(?,?,?,?,?)`).bind(clientId, "day_record", "write", "service", "svc_test_admin"),
    ]);
    const accessToken = await token(privateKey, "user", userId, clientId, ["resources:read", "resources:write"]);
    const response = await request(publicKey, accessToken, `/api/v1/spaces/${spaceId}/_discovery`);
    expect(response.status).toBe(200);
    const payload = await response.json<{ data: { models: Array<{ key: string; actions: DiscoveredAction[] }> } }>();
    const action = payload.data.models.find((entry) => entry.key === "day_record")?.actions
      .find((entry) => entry.key === "record-occurrence");
    expect(action?.input.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "occurredOn", title: "Occurrence Date" }),
      expect.objectContaining({ key: "note", title: "Note" }),
    ]));
    expect(action?.input.fields.some((field) => field.key === "version")).toBe(false);
    expect(action?.concurrency).toEqual({
      strategy: "record-version",
      required: true,
      transport: { in: "body", name: "version" },
    });
  });

  it("exposes the same field titles, defaults and sort metadata through cross-Space discovery", async () => {
    const f = await fixture();
    const accessToken = await token(
      f.privateKey,
      "user",
      f.userId,
      f.clientId,
      ["resources:read", "resources:write"],
    );

    const response = await request(f.publicKey, accessToken, "/api/v1/me/_discovery");
    expect(response.status).toBe(200);
    const payload = await response.json<{ data: { spaces: Array<{
      spaceId: string;
      models: Array<{
        key: string;
        defaults: Record<string, unknown>;
        fields: Array<{ key: string; title?: string }>;
        query: DiscoveredQuery;
      }>;
    }> } }>();
    const space = payload.data.spaces.find((entry) => entry.spaceId === f.spaceId);
    const model = space?.models.find((entry) => entry.key === f.modelKey);
    expect(model?.defaults).toEqual({ status: "open" });
    expect(model?.fields.find((field) => field.key === "title")?.title).toBe("Title");
    expect(model?.query.sort.repeatable).toBe(true);
    expect(model?.query.sort.ordered).toBe(true);
  });

  it("removes write-only actions when the credential has read scope only", async () => {
    const f = await fixture();
    const accessToken = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);
    const response = await request(f.publicKey, accessToken, `/api/v1/spaces/${f.spaceId}/_discovery`);
    const payload = await response.json<{ data: { models: Array<{ key: string; access: string[]; actions: unknown[] }> } }>();
    const model = payload.data.models.find((entry) => entry.key === f.modelKey);
    expect(model?.access).toEqual(["read"]);
    expect(model?.actions).toEqual([]);
  });

  it("tracks current service Data Grant authority without hidden Space membership", async () => {
    const f = await fixture();
    const grantId = `grt_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      grantId,
      f.spaceId,
      "service",
      f.serviceId,
      "model",
      f.modelKey,
      "write",
      f.userId,
      f.now,
      null,
    ).run();

    const accessToken = await token(
      f.privateKey,
      "service",
      f.serviceId,
      f.clientId,
      ["resources:read", "resources:write"],
    );
    const first = await request(f.publicKey, accessToken, `/api/v1/spaces/${f.spaceId}/_discovery`);
    const firstPayload = await first.json<{ data: { spaceName: string | null; models: Array<{ key: string }> } }>();
    expect(firstPayload.data.spaceName).toBe("Discovery Test");
    expect(firstPayload.data.models.some((model) => model.key === f.modelKey)).toBe(true);

    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
    const second = await request(f.publicKey, accessToken, `/api/v1/spaces/${f.spaceId}/_discovery`);
    const secondPayload = await second.json<{ data: { spaceName: string | null; models: Array<{ key: string }> } }>();
    expect(secondPayload.data.spaceName).toBeNull();
    expect(secondPayload.data.models.some((model) => model.key === f.modelKey)).toBe(false);
  });
});

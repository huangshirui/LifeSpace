import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
type Actor = { id: string };

type Fixture = {
  db: D1Database;
  privateKey: string;
  publicKey: string;
  userId: string;
  serviceId: string;
  clientId: string;
  spaceId: string;
  modelKey: string;
  now: string;
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

async function token(
  privateKey: string,
  principalType: "user" | "service",
  principalId: string,
  clientId: string,
  scopes: string[],
  actor?: Actor,
) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: principalId,
    azp: clientId,
    principal_type: principalType,
    ...(actor ? { actor_type: "agent", actor_id: actor.id, purpose: "delegated_agent" } : {}),
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, accessToken: string, path: string, init?: RequestInit) {
  return createApp().request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function fixture(): Promise<Fixture> {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_${suffix}`;
  const serviceId = `svc_${suffix}`;
  const clientId = `app_semantic_detail_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const modelKey = `semantic_note_${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Semantic Detail", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, spaceId, userId, "Semantic Owner", now, now),
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
    display: { singular: "Semantic Note", plural: "Semantic Notes" },
    description: "Model used to prove progressive static semantic projection.",
    fields: {
      zeta: { type: "string", title: "Zeta", required: true, minLength: 1, maxLength: 120 },
      status: { type: "enum", title: "Status", required: true, values: ["open", "done"] },
      rank: { type: "integer", title: "Rank", minimum: 0, maximum: 100 },
      ownerPersonId: { type: "person", title: "Owner", nullable: true },
    },
    defaults: { status: "open" },
    query: { searchable: ["zeta"], filterable: ["status", "rank", "ownerPersonId"], sortable: ["zeta", "rank"] },
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

  return { db, privateKey, publicKey, userId, serviceId, clientId, spaceId, modelKey, now };
}

async function detail(f: Fixture, accessToken: string): Promise<Response> {
  return request(
    f.publicKey,
    accessToken,
    `/api/v1/spaces/${f.spaceId}/_discovery/models/${f.modelKey}`,
  );
}

async function responseData(response: Response): Promise<any> {
  return (await response.json<{ data: any }>()).data;
}

async function responseError(response: Response): Promise<{ code: string; message: string }> {
  return (await response.json<{ error: { code: string; message: string } }>()).error;
}

describe("Progressive single-model semantic detail", () => {
  it("returns static shared semantic facts after a current visibility check without effective Space authority state", async () => {
    const f = await fixture();
    const readOnly = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);
    const response = await detail(f, readOnly);
    expect(response.status).toBe(200);
    const data = await responseData(response);

    expect(data).toMatchObject({
      key: f.modelKey,
      display: { singular: "Semantic Note", plural: "Semantic Notes" },
      description: "Model used to prove progressive static semantic projection.",
      declaredAccess: ["read", "write"],
      defaults: { status: "open" },
      capabilities: [],
      capabilityBindings: {},
    });
    expect(data.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.version).toBeGreaterThanOrEqual(1);
    expect(data.access).toBeUndefined();
    expect(data.spaceId).toBeUndefined();
    expect(data.spaceName).toBeUndefined();
    expect(data.membership).toBeUndefined();
    expect(data.grant).toBeUndefined();
    expect(data.delegation).toBeUndefined();

    expect(data.fields.map((field: { key: string }) => field.key)).toEqual(["ownerPersonId", "rank", "status", "zeta"]);
    expect(data.fields.find((field: { key: string }) => field.key === "ownerPersonId")?.relation).toEqual({
      targetModel: "person",
      cardinality: "one",
      resolution: {
        supported: true,
        method: "POST",
        pathTemplate: "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}",
        maxIds: 50,
      },
    });
    expect(data.query.search).toEqual({ parameter: "q", minLength: 1, maxLength: 100 });
    expect(data.query.filters).toEqual(expect.arrayContaining([
      { field: "status", parameter: "status", mode: "enum-set" },
      { field: "rank", parameter: "rank", mode: "exact", range: { fromParameter: "rankFrom", toParameter: "rankTo" } },
      { field: "ownerPersonId", parameter: "ownerPersonId", mode: "exact" },
    ]));
    expect(data.query.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "rank",
        source: "model",
        valueType: "integer",
        operators: expect.arrayContaining([
          { operator: "gte", parameter: "rankFrom", transport: "legacy" },
          { operator: "lt", parameter: "rank.lt", transport: "explicit" },
        ]),
      }),
      expect.objectContaining({
        field: "createdAt",
        source: "envelope",
        valueType: "datetime",
        localDateWindow: {
          dateStartParameter: "createdAt.dateStart",
          dateEndExclusiveParameter: "createdAt.dateEndExclusive",
          timezoneParameter: "createdAt.timezone",
          bounds: "[)",
          lowerOperator: "gte",
          upperOperator: "lt",
        },
      }),
      expect.objectContaining({ field: "updatedAt", source: "envelope", valueType: "datetime" }),
    ]));
    expect(data.query.pagination).toEqual({
      limit: { parameter: "limit", minimum: 1, maximum: 200, default: 100 },
      cursor: { parameter: "cursor", type: "string" },
    });
    expect(data.query.sort).toMatchObject({
      parameter: "sort",
      syntax: "field:direction",
      repeatable: true,
      ordered: true,
      maxCriteria: 8,
      genericDefault: ["createdAt:desc"],
      envelopeFields: ["createdAt", "updatedAt"],
      nullPlacement: "last",
    });
    expect(data.actions).toContainEqual({
      key: "complete",
      access: "write",
      kind: "workflow",
      input: { fields: [] },
      concurrency: {
        strategy: "record-version",
        required: true,
        transport: { in: "body", name: "version" },
      },
      invocation: {
        method: "POST",
        pathTemplate: `/api/v1/spaces/{spaceId}/models/${f.modelKey}/records/{recordId}/actions/complete`,
      },
    });
  });

  it("returns the same static body to a service with a model Data Grant and hides it immediately after Grant revoke", async () => {
    const f = await fixture();
    const userToken = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"]);
    const userResponse = await detail(f, userToken);
    expect(userResponse.status).toBe(200);
    const userData = await responseData(userResponse);

    const grantId = `grt_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.prepare(`INSERT INTO data_grants(
      id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
      grantId, f.spaceId, "service", f.serviceId, "model", f.modelKey, "read", f.userId, f.now, null,
    ).run();
    const serviceToken = await token(f.privateKey, "service", f.serviceId, f.clientId, ["resources:read"]);
    const serviceResponse = await detail(f, serviceToken);
    expect(serviceResponse.status).toBe(200);
    expect(await responseData(serviceResponse)).toEqual(userData);

    await f.db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?").bind(new Date().toISOString(), grantId).run();
    const revoked = await detail(f, serviceToken);
    expect(revoked.status).toBe(404);
    expect(await responseError(revoked)).toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  });

  it("returns the same static body under delegated Agent authority and hides it immediately after Delegation revoke", async () => {
    const f = await fixture();
    const direct = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read", "resources:write"]);
    const directResponse = await detail(f, direct);
    expect(directResponse.status).toBe(200);
    const directData = await responseData(directResponse);

    const agentId = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const delegationResponse = await request(f.publicKey, direct, `/api/v1/spaces/${f.spaceId}/agent-delegations`, {
      method: "POST",
      body: JSON.stringify({ agentId, models: [{ modelKey: f.modelKey, maxAccess: "read" }] }),
    });
    expect(delegationResponse.status).toBe(201);
    const delegation = await responseData(delegationResponse);

    const delegated = await token(f.privateKey, "user", f.userId, f.clientId, ["resources:read"], { id: agentId });
    const agentResponse = await detail(f, delegated);
    expect(agentResponse.status).toBe(200);
    expect(await responseData(agentResponse)).toEqual(directData);

    const revokeResponse = await request(
      f.publicKey,
      direct,
      `/api/v1/spaces/${f.spaceId}/agent-delegations/${delegation.id}`,
      { method: "DELETE" },
    );
    expect(revokeResponse.status).toBe(204);
    const revoked = await detail(f, delegated);
    expect(revoked.status).toBe(404);
    expect(await responseError(revoked)).toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
  });

  it("uses the same opaque 404 for a published-but-invisible model and an unknown model key", async () => {
    const f = await fixture();
    const hiddenClientId = `app_hidden_${crypto.randomUUID().replaceAll("-", "")}`;
    const hiddenToken = await token(f.privateKey, "user", f.userId, hiddenClientId, ["resources:read"]);

    const invisible = await detail(f, hiddenToken);
    expect(invisible.status).toBe(404);
    const invisibleError = await responseError(invisible);

    const missing = await request(
      f.publicKey,
      hiddenToken,
      `/api/v1/spaces/${f.spaceId}/_discovery/models/missing_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
    );
    expect(missing.status).toBe(404);
    const missingError = await responseError(missing);

    expect(invisibleError).toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
    expect(missingError).toMatchObject({ code: "NOT_FOUND", message: "Resource not found" });
    expect({ code: missingError.code, message: missingError.message }).toEqual({
      code: invisibleError.code,
      message: invisibleError.message,
    });
  });
});

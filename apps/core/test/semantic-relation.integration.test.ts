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

async function token(privateKey: string, userId: string, clientId: string) {
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

async function request(
  publicKey: string,
  bearer: string,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function json(response: Response) {
  return response.json<any>();
}

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_${suffix}`;
  const clientId = `app_semrel_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const sourceModelKey = `semantic_source_${suffix.slice(0, 8)}`;
  const targetModelKey = `semantic_target_${suffix.slice(0, 8)}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(spaceId, "Semantic Relation", userId, now, now, "UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`per_${suffix}`, spaceId, userId, "Owner", now, now),
  ]);

  const publisher: Principal = {
    type: "service",
    id: `svc_semrel_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: sourceModelKey,
    display: { singular: "Semantic Source", plural: "Semantic Sources" },
    fields: { name: { type: "string", required: true } },
    semanticRelations: { outgoing: ["relates_to"] },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    key: targetModelKey,
    display: { singular: "Semantic Target", plural: "Semantic Targets" },
    fields: { name: { type: "string", required: true } },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");
  await db.batch([
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, sourceModelKey, "write", "service", publisher.id),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, targetModelKey, "write", "service", publisher.id),
  ]);

  return {
    db,
    publicKey,
    bearer: await token(privateKey, userId, clientId),
    clientId,
    spaceId,
    sourceModelKey,
    targetModelKey,
  };
}

async function createRecord(
  f: Awaited<ReturnType<typeof fixture>>,
  modelKey: string,
  name: string,
) {
  const response = await request(
    f.publicKey,
    f.bearer,
    `/api/v1/spaces/${f.spaceId}/models/${modelKey}/records`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  expect(response.status).toBe(201);
  return (await json(response)).data as { id: string; version: number };
}

describe("Semantic Relation Runtime", () => {
  it("creates an idempotent cross-model edge and does not duplicate Change evidence", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    const body = {
      source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id },
      predicate: "relates_to",
      target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
    };

    const first = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`,
      { method: "POST", body: JSON.stringify(body) },
    );
    expect(first.status).toBe(200);
    const firstRelation = (await json(first)).data as { id: string };

    const retry = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`,
      { method: "POST", body: JSON.stringify(body) },
    );
    expect(retry.status).toBe(200);
    expect((await json(retry)).data.id).toBe(firstRelation.id);

    const changeCount = await f.db.prepare(`SELECT COUNT(*) count FROM semantic_relation_changes
      WHERE relation_id=? AND operation='create'`).bind(firstRelation.id).first<{ count: number }>();
    expect(Number(changeCount?.count ?? 0)).toBe(1);
  });

  it("creates a new source Record and its Semantic Relations in one ChangeSet", async () => {
    const f = await fixture();
    const target = await createRecord(f, f.targetModelKey, "target");
    const response = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/models/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          operations: [{
            operation: "create",
            modelKey: f.sourceModelKey,
            data: { name: "atomic source" },
            semanticRelations: [{
              predicate: "relates_to",
              target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
            }],
          }],
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = (await json(response)).data;
    expect(result.items[0].semanticRelationIds).toHaveLength(1);

    const relationId = result.items[0].semanticRelationIds[0] as string;
    const relation = await f.db.prepare(`SELECT source_record_id,target_record_id FROM semantic_relations WHERE id=?`)
      .bind(relationId).first<{ source_record_id: string; target_record_id: string }>();
    expect(relation).toEqual({
      source_record_id: result.items[0].recordId,
      target_record_id: target.id,
    });
    const change = await f.db.prepare(`SELECT source_resource_change_id,change_set_id
      FROM semantic_relation_changes WHERE relation_id=? AND operation='create'`).bind(relationId)
      .first<{ source_resource_change_id: string; change_set_id: string }>();
    expect(change?.change_set_id).toBe(result.changeSetId);
    expect(change?.source_resource_change_id).toMatch(/^chg_/);
  });

  it("rolls back the new source Record when a Batch Semantic Relation target is missing", async () => {
    const f = await fixture();
    const before = await f.db.prepare(`SELECT COUNT(*) count FROM resource_records
      WHERE space_id=? AND model_key=?`).bind(f.spaceId, f.sourceModelKey).first<{ count: number }>();
    const response = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/models/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          operations: [{
            operation: "create",
            modelKey: f.sourceModelKey,
            data: { name: "must not commit" },
            semanticRelations: [{
              predicate: "relates_to",
              target: {
                kind: "record",
                modelKey: f.targetModelKey,
                recordId: `rec_missing_${crypto.randomUUID().replaceAll("-", "")}`,
              },
            }],
          }],
        }),
      },
    );
    expect(response.status).toBe(404);
    const after = await f.db.prepare(`SELECT COUNT(*) count FROM resource_records
      WHERE space_id=? AND model_key=?`).bind(f.spaceId, f.sourceModelKey).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("hides a relation when either endpoint is no longer exposed and atomically cleans it on endpoint delete", async () => {
    const f = await fixture();
    const source = await createRecord(f, f.sourceModelKey, "source");
    const target = await createRecord(f, f.targetModelKey, "target");
    const create = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations`,
      {
        method: "POST",
        body: JSON.stringify({
          source: { kind: "record", modelKey: f.sourceModelKey, recordId: source.id },
          predicate: "relates_to",
          target: { kind: "record", modelKey: f.targetModelKey, recordId: target.id },
        }),
      },
    );
    const relationId = (await json(create)).data.id as string;

    await f.db.prepare(`DELETE FROM application_model_access WHERE application_id=? AND model_key=?`)
      .bind(f.clientId, f.targetModelKey).run();
    const hidden = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/semantic-relations/${relationId}`,
    );
    expect(hidden.status).toBe(404);

    await f.db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(f.clientId, f.targetModelKey, "write", "service", "svc_restore").run();
    const deleted = await request(
      f.publicKey,
      f.bearer,
      `/api/v1/spaces/${f.spaceId}/models/${f.targetModelKey}/records/${target.id}?version=${target.version}`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(204);

    const edge = await f.db.prepare("SELECT id FROM semantic_relations WHERE id=?").bind(relationId).first();
    expect(edge).toBeNull();
    const cleanup = await f.db.prepare(`SELECT source_resource_change_id FROM semantic_relation_changes
      WHERE relation_id=? AND operation='endpoint_delete'`).bind(relationId)
      .first<{ source_resource_change_id: string }>();
    expect(cleanup?.source_resource_change_id).toMatch(/^chg_/);
  });
});

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

async function userToken(privateKey: string, userId: string, clientId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_configuration_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, bearer: string, path: string) {
  return createApp().request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function responseData(response: Response): Promise<any> {
  expect(response.status).toBe(200);
  return (await response.json<{ data: any }>()).data;
}

describe("Application-scoped configuration model discovery", () => {
  it("exposes model semantics without Space authority while runtime Discovery stays empty", async () => {
    const db = (env as unknown as TestEnv).DB;
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_configuration_${suffix}`;
    const clientId = `app_configuration_${suffix}`;
    const modelKey = `configuration_note_${suffix.slice(0, 8)}`;

    const publisher: Principal = {
      type: "service",
      id: `svc_configuration_publisher_${suffix}`,
      clientId: "lifespace-platform-admin",
      scopes: ["models:manage"],
      tokenId: `tok_configuration_admin_${suffix}`,
    };
    await publishModelDefinition({ DB: db } as Bindings, publisher, {
      definitionVersion: 1,
      key: modelKey,
      display: { singular: "Configuration Note", plural: "Configuration Notes" },
      description: "Configuration-only semantic discovery fixture.",
      fields: {
        title: { type: "string", title: "Title", required: true, minLength: 1, maxLength: 120 },
      },
      query: { searchable: ["title"], filterable: [], sortable: ["title"] },
      access: ["read", "write"],
      lifecycle: { optimisticConcurrency: true, softDelete: true },
    }, "initial");

    await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", "svc_test_admin").run();

    const bearer = await userToken(privateKey, userId, clientId, ["resources:read", "resources:write"]);

    const runtime = await responseData(await request(publicKey, bearer, "/api/v1/me/_discovery/inventory"));
    expect(runtime.models).toEqual([]);
    expect(runtime.spaces).toEqual([]);

    const inventory = await responseData(await request(publicKey, bearer, "/api/v1/me/_discovery/models"));
    expect(inventory.semanticDetailPathTemplate).toBe("/api/v1/me/_discovery/models/{modelKey}");
    expect(inventory.models).toEqual([
      expect.objectContaining({
        key: modelKey,
        access: ["read", "write"],
        display: { singular: "Configuration Note", plural: "Configuration Notes" },
      }),
    ]);

    const detail = await responseData(await request(publicKey, bearer, `/api/v1/me/_discovery/models/${modelKey}`));
    expect(detail.access).toEqual(["read", "write"]);
    expect(detail.model).toMatchObject({
      key: modelKey,
      display: { singular: "Configuration Note", plural: "Configuration Notes" },
      declaredAccess: ["read", "write"],
    });
    expect(detail.model.fields).toEqual([
      expect.objectContaining({ key: "title", type: "string", required: true }),
    ]);

    await db.prepare("UPDATE application_model_access SET max_access='read' WHERE application_id=? AND model_key=?")
      .bind(clientId, modelKey).run();
    const readOnly = await responseData(await request(publicKey, bearer, `/api/v1/me/_discovery/models/${modelKey}`));
    expect(readOnly.access).toEqual(["read"]);

    await db.prepare("DELETE FROM application_model_access WHERE application_id=? AND model_key=?")
      .bind(clientId, modelKey).run();
    const hidden = await request(publicKey, bearer, `/api/v1/me/_discovery/models/${modelKey}`);
    expect(hidden.status).toBe(404);
    const after = await responseData(await request(publicKey, bearer, "/api/v1/me/_discovery/models"));
    expect(after.models).toEqual([]);
  });

  it("intersects configuration semantics with the credential scope ceiling", async () => {
    const db = (env as unknown as TestEnv).DB;
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_configuration_scope_${suffix}`;
    const clientId = `app_configuration_scope_${suffix}`;
    const modelKey = `configuration_scope_${suffix.slice(0, 8)}`;
    const publisher: Principal = {
      type: "service",
      id: `svc_configuration_scope_publisher_${suffix}`,
      clientId: "lifespace-platform-admin",
      scopes: ["models:manage"],
      tokenId: `tok_configuration_scope_admin_${suffix}`,
    };

    await publishModelDefinition({ DB: db } as Bindings, publisher, {
      definitionVersion: 1,
      key: modelKey,
      display: { singular: "Scoped Note", plural: "Scoped Notes" },
      fields: { title: { type: "string", required: true } },
      access: ["read", "write"],
      lifecycle: { optimisticConcurrency: true, softDelete: true },
    }, "initial");
    await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, modelKey, "write", "service", "svc_test_admin").run();

    const readOnlyBearer = await userToken(privateKey, userId, clientId, ["resources:read"]);
    const detail = await responseData(await request(
      publicKey,
      readOnlyBearer,
      `/api/v1/me/_discovery/models/${modelKey}`,
    ));
    expect(detail.access).toEqual(["read"]);
  });
});

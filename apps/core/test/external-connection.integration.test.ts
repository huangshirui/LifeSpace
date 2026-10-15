import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings, Principal } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";

const shared = "synthetic-external-connection-shared-secret-32";
const pem = (label: string, bytes: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${btoa(String.fromCharCode(...new Uint8Array(bytes))).match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----`;

async function fixture() {
  const db = (env as unknown as { DB: D1Database }).DB;
  const app = createApp();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const space = `spc_${suffix}`;
  const user = `usr_${suffix}`;
  const other = `usr_other_${suffix}`;
  const application = `app_${suffix}`;
  const definitionKey = `external_connection_${suffix.slice(0, 8)}`;
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
  const timestamp = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(space, "External Connection Test", user, timestamp, timestamp, "UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(`mem_${suffix}`, space, user, "owner", timestamp, timestamp),
  ]);
  const publisher: Principal = {
    type: "service",
    id: `svc_${suffix}`,
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: `tok_admin_${suffix}`,
  };
  await publishModelDefinition({ DB: db } as Bindings, publisher, {
    definitionVersion: 1,
    origin: "external",
    key: definitionKey,
    description: "Synthetic dynamic connection definition.",
    display: { singular: "External Record", plural: "External Records" },
    fields: {},
    access: ["read", "write"],
  }, "initial");

  const vault = new Map<string, { token: string; access: "read" | "write" }>();
  const calls: Array<{ path: string; operation: string; credentialRef?: string }> = [];
  const resourceId = `12345678-1234-1234-1234-${suffix.slice(0, 12)}`;
  const fieldKey = `f_${"a".repeat(32)}`;
  const adapter = {
    async fetch(url: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(url, init);
      expect(request.headers.get("x-lifespace-internal-secret")).toBe(shared);
      const path = new URL(request.url).pathname;
      const body = await request.json<any>();
      calls.push({ path, operation: body.operation, credentialRef: body.credentialRef });
      if (path === "/internal/v1/external-connections") {
        if (body.operation === "describe") {
          return Response.json({ contractVersion: 1, data: {
            key: "notion", displayName: "Notion",
            credential: { type: "bearer_token", displayName: "Integration token" },
            resource: { type: "data_source", displayName: "Data source" },
            access: ["read", "write"],
          } });
        }
        if (body.operation === "create") {
          expect(body.credentialRef).toMatch(/^cnx_[a-f0-9]{32}$/u);
          expect(body.credential).toEqual({ type: "bearer_token", token: "secret-token-v1" });
          vault.set(body.credentialRef, { token: body.credential.token, access: body.access });
          return Response.json({ contractVersion: 1, data: { read: true, write: body.access === "write" } });
        }
        if (body.operation === "update") {
          const current = vault.get(body.credentialRef);
          if (!current) return Response.json({ contractVersion: 1, error: { code: "EXTERNAL_ACCESS_DENIED", retrySafe: true } }, { status: 503 });
          const next = {
            token: body.credential?.token ?? current.token,
            access: body.access ?? current.access,
          } as { token: string; access: "read" | "write" };
          vault.set(body.credentialRef, next);
          return Response.json({ contractVersion: 1, data: { read: true, write: next.access === "write" } });
        }
        if (body.operation === "listResources") {
          expect(vault.has(body.credentialRef)).toBe(true);
          return Response.json({ contractVersion: 1, data: { items: [{ id: resourceId, type: "data_source", displayName: "Health Documents" }], nextCursor: null } });
        }
        if (body.operation === "delete") {
          vault.delete(body.credentialRef);
          return Response.json({ contractVersion: 1, data: { deleted: true } });
        }
      }
      if (path === "/internal/v1/external-models" && body.operation === "discover") {
        expect(vault.has(body.credentialRef)).toBe(true);
        return Response.json({ contractVersion: 1, data: {
          resourceId,
          displayName: "Health Documents",
          fields: [{ key: fieldKey, sourceFieldId: "title", title: "Name", type: "string", nullable: false, readable: true, writable: true, operators: ["eq", "contains"], sortable: true }],
          capabilities: { get: true, query: true, create: true, update: true, delete: true, batchWrite: true, atomicBatch: false, transaction: false, versionedWrite: false, actions: false, relationTargetResolution: false },
          queryLimits: { maxDepth: 2, maxNodes: 100, maxSort: 8, maxPageSize: 100 },
          adapterState: { codecs: { [fieldKey]: { id: "title", type: "title" } } },
        } });
      }
      return Response.json({ contractVersion: 1, error: { code: "EXTERNAL_CONTRACT_INVALID", retrySafe: false } }, { status: 502 });
    },
  } as Fetcher;

  const bindings = {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    EXTERNAL_ADAPTER: adapter,
    EXTERNAL_ADAPTER_SHARED_SECRET: shared,
    EXTERNAL_SCHEMA_REFRESH_SECONDS: "300",
  } as unknown as Bindings;

  async function token(id = user, actor?: string) {
    const now = Math.floor(Date.now() / 1000);
    return sign({
      iss: "lifespace-identity", aud: "lifespace-core", sub: actor ?? id,
      principal_type: "user", azp: application, scope: "spaces:manage",
      iat: now, exp: now + 900, jti: `tok_${crypto.randomUUID().replaceAll("-", "")}`,
      ...(actor ? { actor_type: "agent", actor_id: actor, principal_id: id, purpose: "agent_execution" } : {}),
    }, privateKey, "RS256");
  }

  async function request(path: string, method = "GET", body?: unknown, bearer?: string) {
    const authorization = bearer ?? await token();
    return app.request(`https://example.com${path}`, {
      method,
      headers: { authorization: `Bearer ${authorization}`, accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, bindings);
  }

  return { db, space, user, other, application, definitionKey, vault, calls, resourceId, fieldKey, request, token };
}

describe("Space External Connection self-service", () => {
  it("completes create, resource discovery, model binding, stored schema inspection, rotation and revoke without persisting provider plaintext", async () => {
    const f = await fixture();
    const providers = await f.request(`/api/v1/spaces/${f.space}/external-providers`);
    expect(providers.status).toBe(200);
    expect((await providers.json<any>()).data.items[0].key).toBe("notion");

    const created = await f.request(`/api/v1/spaces/${f.space}/external-connections`, "POST", {
      providerKey: "notion",
      displayName: "My Notion",
      credential: { type: "bearer_token", token: "secret-token-v1" },
      access: "write",
    });
    expect(created.status, JSON.stringify(await created.clone().json())).toBe(201);
    const connection = (await created.json<any>()).data;
    expect(connection.id).toMatch(/^exs_[a-f0-9]{32}$/u);
    expect(connection).not.toHaveProperty("credential");
    expect(connection).not.toHaveProperty("credentialRef");
    expect(connection).not.toHaveProperty("managementMode");
    expect(connection.resourceDiscovery).toBe(true);

    const row = await f.db.prepare("SELECT credential_ref,display_name,access_mode FROM external_sources WHERE id=?").bind(connection.id).first<any>();
    expect(row.credential_ref).toMatch(/^cnx_[a-f0-9]{32}$/u);
    expect(JSON.stringify(row)).not.toContain("secret-token-v1");
    expect(f.vault.get(row.credential_ref)?.token).toBe("secret-token-v1");

    const listed = await f.request(`/api/v1/spaces/${f.space}/external-connections`);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.clone().json())).not.toContain("secret-token-v1");

    const resources = await f.request(`/api/v1/spaces/${f.space}/external-connections/${connection.id}/resources?limit=20&query=Health`);
    expect(resources.status, JSON.stringify(await resources.clone().json())).toBe(200);
    expect((await resources.json<any>()).data.items).toEqual([{ id: f.resourceId, type: "data_source", displayName: "Health Documents" }]);

    const bound = await f.request(`/api/v1/spaces/${f.space}/external-models`, "POST", {
      definitionKey: f.definitionKey,
      connectionId: connection.id,
      resourceId: f.resourceId,
      declaredAccess: "write",
    });
    expect(bound.status, JSON.stringify(await bound.clone().json())).toBe(201);
    expect((await bound.json<any>()).data.connectionId).toBe(connection.id);

    const callsBeforeDetail = f.calls.length;
    const detailResponse = await f.request(`/api/v1/spaces/${f.space}/external-models/${f.definitionKey}`);
    expect(detailResponse.status, JSON.stringify(await detailResponse.clone().json())).toBe(200);
    const detail = (await detailResponse.json<any>()).data;
    expect(detail.modelKey).toBe(f.definitionKey);
    expect(detail.connectionId).toBe(connection.id);
    expect(detail.fields).toEqual([{ key: f.fieldKey, title: "Name", type: "string", nullable: false, readable: true, writable: true, operators: ["eq", "contains"], sortable: true }]);
    expect(detail.fields[0]).not.toHaveProperty("sourceFieldId");
    expect(detail).not.toHaveProperty("adapterState");
    expect(f.calls).toHaveLength(callsBeforeDetail);

    const rotated = await f.request(`/api/v1/spaces/${f.space}/external-connections/${connection.id}`, "PATCH", {
      displayName: "My Notion (rotated)",
      credential: { type: "bearer_token", token: "secret-token-v2" },
      access: "read",
    });
    expect(rotated.status).toBe(200);
    expect((await rotated.json<any>()).data.access).toBe("read");
    expect(f.vault.get(row.credential_ref)?.token).toBe("secret-token-v2");
    expect((await f.db.prepare("SELECT declared_access FROM external_models WHERE source_id=?").bind(connection.id).first<any>()).declared_access).toBe("read");
    const bindingList = await f.request(`/api/v1/spaces/${f.space}/external-models`);
    expect(bindingList.status).toBe(200);
    expect((await bindingList.json<any>()).data.items[0].declaredAccess).toBe("read");

    const readDetail = await f.request(`/api/v1/spaces/${f.space}/external-models/${f.definitionKey}`);
    expect(readDetail.status).toBe(200);
    expect((await readDetail.json<any>()).data.fields[0].writable).toBe(false);

    const writeDenied = await f.request(`/api/v1/spaces/${f.space}/external-models`, "POST", {
      definitionKey: f.definitionKey,
      connectionId: connection.id,
      resourceId: `${f.resourceId}-other`,
      declaredAccess: "write",
    });
    expect(writeDenied.status).toBe(422);

    const revoked = await f.request(`/api/v1/spaces/${f.space}/external-connections/${connection.id}`, "DELETE");
    expect(revoked.status).toBe(204);
    expect(f.vault.has(row.credential_ref)).toBe(false);
    const metadata = await f.db.prepare("SELECT status,revoked_at FROM external_sources WHERE id=?").bind(connection.id).first<any>();
    expect(metadata.status).toBe("disabled");
    expect(metadata.revoked_at).toBeTruthy();
    expect((await f.db.prepare("SELECT status FROM external_models WHERE source_id=?").bind(connection.id).first<any>()).status).toBe("disabled");
    const disabledDetail = await f.request(`/api/v1/spaces/${f.space}/external-models/${f.definitionKey}`);
    expect(disabledDetail.status).toBe(200);
    expect((await disabledDetail.json<any>()).data.status).toBe("disabled");
  });

  it("rejects delegated/non-manager creation, caller credentialRef injection and corrupt non-dynamic metadata", async () => {
    const f = await fixture();
    const delegated = await f.token(f.user, `agt_${crypto.randomUUID().replaceAll("-", "")}`);
    expect((await f.request(`/api/v1/spaces/${f.space}/external-connections`, "POST", {
      providerKey: "notion", displayName: "Nope", credential: { type: "bearer_token", token: "secret-token-v1" }, access: "read",
    }, delegated)).status).toBe(403);

    const other = await f.token(f.other);
    expect((await f.request(`/api/v1/spaces/${f.space}/external-connections`, "POST", {
      providerKey: "notion", displayName: "Nope", credential: { type: "bearer_token", token: "secret-token-v1" }, access: "read",
    }, other)).status).toBe(403);

    const injected = await f.request(`/api/v1/spaces/${f.space}/external-connections`, "POST", {
      providerKey: "notion", displayName: "Nope", credential: { type: "bearer_token", token: "secret-token-v1" }, access: "read", credentialRef: "static_ref",
    });
    expect(injected.status).toBe(400);

    const now = new Date().toISOString();
    const corruptId = `exs_${crypto.randomUUID().replaceAll("-", "")}`;
    await f.db.prepare("INSERT INTO external_sources(id,space_id,provider_key,credential_ref,status,display_name,access_mode,created_at,updated_at) VALUES(?,?,?,'static_ref','active','Corrupt connection','write',?,?)")
      .bind(corruptId, f.space, "notion", now, now).run();
    expect((await f.request(`/api/v1/spaces/${f.space}/external-connections/${corruptId}/resources`)).status).toBe(503);
    expect((await f.request(`/api/v1/spaces/${f.space}/external-connections/${corruptId}`, "PATCH", { status: "disabled" })).status).toBe(503);
    expect((await f.request(`/api/v1/spaces/${f.space}/external-connections/${corruptId}`, "DELETE")).status).toBe(503);
  });
});

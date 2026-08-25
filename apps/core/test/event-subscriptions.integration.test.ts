import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

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

async function token(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "test-app",
    principal_type: "user",
    scope: "profile:read spaces:read spaces:write spaces:manage resources:read resources:write",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, accessToken: string, publicKey: string, init: RequestInit = {}) {
  const db = (env as unknown as TestEnv).DB;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function createFamily(accessToken: string, publicKey: string) {
  const response = await request("/api/v1/spaces", accessToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name: "Event subscription test", ownerDisplayName: "Owner", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ data: { id: string } }>()).data.id;
}

describe("Webhook endpoint and event subscription authorization", () => {
  it("shares one destination and signing secret across event and task filters", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID()}`;
    const subscriberId = `svc_${crypto.randomUUID()}`;
    const accessToken = await token(privateKey, userId);
    const spaceId = await createFamily(accessToken, publicKey);
    const db = (env as unknown as TestEnv).DB;
    const now = new Date().toISOString();

    for (const modelKey of ["event", "task"]) {
      await db.prepare(`INSERT OR REPLACE INTO application_model_access(
        application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)`)
        .bind("test-app", modelKey, "read", "user", userId, now, now)
        .run();
    }

    const endpointResponse = await request("/api/v1/webhook-endpoints", accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        spaceId,
        subscriberServicePrincipalId: subscriberId,
        name: "Home automation",
        webhookUrl: "https://example.com/hooks/homemew",
      }),
    });
    expect(endpointResponse.status).toBe(201);
    const endpoint = await endpointResponse.json<{ data: {
      id: string;
      destination: { url: string };
      signingSecret: string;
    } }>();
    expect(endpoint.data.destination.url).toBe("https://example.com/hooks/homemew");
    expect(endpoint.data.signingSecret).toHaveLength(64);

    const denied = await request("/api/v1/event-subscriptions", accessToken, publicKey, {
      method: "POST",
      body: JSON.stringify({
        endpointId: endpoint.data.id,
        modelKey: "event",
        eventTypes: ["record.created", "record.updated"],
      }),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json<{ error: { code: string } }>()).error.code).toBe("EVENT_SUBSCRIBER_ACCESS_DENIED");

    const grants: Record<string, string> = {};
    for (const modelKey of ["event", "task"]) {
      const grantId = `grt_${crypto.randomUUID().replaceAll("-", "")}`;
      grants[modelKey] = grantId;
      await db.prepare(`INSERT INTO data_grants(
        id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?)`)
        .bind(grantId, spaceId, "service", subscriberId, "model", modelKey, "read", userId, now)
        .run();
    }

    const createdSubscriptions: Array<{ id: string; endpointId: string; modelKey: string }> = [];
    for (const modelKey of ["event", "task"]) {
      const created = await request("/api/v1/event-subscriptions", accessToken, publicKey, {
        method: "POST",
        body: JSON.stringify({
          endpointId: endpoint.data.id,
          modelKey,
          eventTypes: ["record.created", "record.updated", "record.deleted"],
        }),
      });
      expect(created.status).toBe(201);
      const payload = await created.json<{ data: { id: string; endpointId: string; modelKey: string } }>();
      expect(payload.data.endpointId).toBe(endpoint.data.id);
      expect(payload.data.modelKey).toBe(modelKey);
      createdSubscriptions.push(payload.data);
    }

    const listed = await request(
      `/api/v1/event-subscriptions?endpointId=${encodeURIComponent(endpoint.data.id)}`,
      accessToken,
      publicKey,
    );
    expect(listed.status).toBe(200);
    const listPayload = await listed.json<{ data: { items: Array<{ endpointId: string; modelKey: string }> } }>();
    expect(listPayload.data.items).toHaveLength(2);
    expect(listPayload.data.items.map((item) => item.modelKey).sort()).toEqual(["event", "task"]);
    expect(listPayload.data.items.every((item) => item.endpointId === endpoint.data.id)).toBe(true);

    const endpoints = await request(
      `/api/v1/webhook-endpoints?spaceId=${encodeURIComponent(spaceId)}&subscriberServicePrincipalId=${encodeURIComponent(subscriberId)}`,
      accessToken,
      publicKey,
    );
    expect(endpoints.status).toBe(200);
    const endpointList = await endpoints.json<{ data: { items: Array<Record<string, unknown>> } }>();
    expect(endpointList.data.items).toHaveLength(1);
    expect(endpointList.data.items[0]).not.toHaveProperty("signingSecret");

    const rotated = await request(`/api/v1/webhook-endpoints/${encodeURIComponent(endpoint.data.id)}`, accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ rotateSigningSecret: true }),
    });
    expect(rotated.status).toBe(200);
    const rotatedPayload = await rotated.json<{ data: { signingSecret: string } }>();
    expect(rotatedPayload.data.signingSecret).toHaveLength(64);
    expect(rotatedPayload.data.signingSecret).not.toBe(endpoint.data.signingSecret);

    await db.prepare("UPDATE data_grants SET revoked_at=? WHERE id=?")
      .bind(new Date().toISOString(), grants.task)
      .run();

    const taskSubscription = createdSubscriptions.find((item) => item.modelKey === "task")!;
    const deniedUpdate = await request(`/api/v1/event-subscriptions/${encodeURIComponent(taskSubscription.id)}`, accessToken, publicKey, {
      method: "PATCH",
      body: JSON.stringify({ eventTypes: ["record.created"] }),
    });
    expect(deniedUpdate.status).toBe(403);
    expect((await deniedUpdate.json<{ error: { code: string } }>()).error.code).toBe("EVENT_SUBSCRIBER_ACCESS_DENIED");
  });
});

import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database; ASSETS: R2Bucket };

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

async function token(privateKey: string, userId: string, scopes: string[], audience: string | string[] = ["lifespace-core", "lifespace-identity"]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: audience,
    sub: userId,
    azp: "homemew-miniprogram",
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function bindings(publicKey: string) {
  const test = env as unknown as TestEnv;
  return { DB: test.DB, ASSETS: test.ASSETS, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" };
}

async function json(response: Response) {
  return response.json() as Promise<any>;
}

describe("Core native Space avatar", () => {
  it("supports stable public avatar URLs, optimistic replacement, cleanup and multi-audience tokens", async () => {
    const { privateKey, publicKey } = await keys();
    const ownerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const ownerToken = await token(privateKey, ownerId, ["spaces:read", "spaces:write", "spaces:manage"]);
    const app = createApp();

    const created = await app.request("http://core.test/api/v1/spaces", {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ kind: "family", name: "Home", ownerDisplayName: "Owner", timezone: "Asia/Shanghai" }),
    }, bindings(publicKey));
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const spaceId = createdBody.data.id as string;
    expect(createdBody.data.avatarUrl).toBeNull();
    expect(createdBody.data.version).toBe(1);

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "home.png", { type: "image/png" }));
    form.set("version", "1");
    const uploaded = await app.request(`http://core.test/api/v1/spaces/${spaceId}/avatar`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerToken}` },
      body: form,
    }, bindings(publicKey));
    expect(uploaded.status).toBe(200);
    const uploadedBody = await json(uploaded);
    expect(uploadedBody.data.avatarUrl).toBe(`http://core.test/assets/spaces/${spaceId}/avatar`);
    expect(uploadedBody.data.version).toBe(2);

    const read = await app.request(`http://core.test/api/v1/spaces/${spaceId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    }, bindings(publicKey));
    expect(read.status).toBe(200);
    const readBody = await json(read);
    expect(readBody.data.avatarUrl).toBe(uploadedBody.data.avatarUrl);
    expect(readBody.data.avatar_key).toBeUndefined();
    expect(readBody.data.version).toBe(2);

    const publicAvatar = await app.request(uploadedBody.data.avatarUrl, {}, bindings(publicKey));
    expect(publicAvatar.status).toBe(200);
    expect(publicAvatar.headers.get("content-type")).toBe("image/png");

    const db = (env as unknown as TestEnv).DB;
    const firstRow = await db.prepare("SELECT avatar_key avatarKey FROM spaces WHERE id=?").bind(spaceId).first<{ avatarKey: string }>();
    expect(firstRow?.avatarKey).toMatch(new RegExp(`^avatars/spaces/${spaceId}/.+\\.png$`));
    expect((await (env as unknown as TestEnv).ASSETS.list({ prefix: `avatars/spaces/${spaceId}/` })).objects).toHaveLength(1);

    const stale = new FormData();
    stale.set("file", new File([new Uint8Array([4])], "stale.webp", { type: "image/webp" }));
    stale.set("version", "1");
    const staleResponse = await app.request(`http://core.test/api/v1/spaces/${spaceId}/avatar`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerToken}` },
      body: stale,
    }, bindings(publicKey));
    expect(staleResponse.status).toBe(409);
    expect((await (env as unknown as TestEnv).ASSETS.list({ prefix: `avatars/spaces/${spaceId}/` })).objects).toHaveLength(1);

    const replacement = new FormData();
    replacement.set("file", new File([new Uint8Array([9, 8])], "replacement.webp", { type: "image/webp" }));
    replacement.set("version", "2");
    const replaced = await app.request(`http://core.test/api/v1/spaces/${spaceId}/avatar`, {
      method: "PUT",
      headers: { authorization: `Bearer ${ownerToken}` },
      body: replacement,
    }, bindings(publicKey));
    expect(replaced.status).toBe(200);
    expect((await json(replaced)).data.version).toBe(3);
    const objects = (await (env as unknown as TestEnv).ASSETS.list({ prefix: `avatars/spaces/${spaceId}/` })).objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].key).not.toBe(firstRow?.avatarKey);
  });

  it("keeps accepting legacy Core-only audience during issuer rollout", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const legacyToken = await token(privateKey, userId, ["profile:read"], "lifespace-core");
    const response = await createApp().request("http://core.test/api/v1/me", {
      headers: { authorization: `Bearer ${legacyToken}` },
    }, bindings(publicKey));
    expect(response.status).toBe(200);
  });
});

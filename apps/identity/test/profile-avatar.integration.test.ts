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

async function userToken(privateKey: string, userId: string, scopes: string[], aud: string | string[] = ["lifespace-core", "lifespace-identity"]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud,
    sub: userId,
    azp: "app_test_identity",
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

function bindings(publicKey: string) {
  const test = env as unknown as TestEnv;
  return {
    DB: test.DB,
    ASSETS: test.ASSETS,
    TOKEN_PUBLIC_KEY: publicKey,
    TOKEN_PRIVATE_KEY: "unused-in-this-test",
    BOOTSTRAP_SECRET: "test-bootstrap-secret-at-least-32-characters",
    ENVIRONMENT: "test",
  };
}

async function seedUser(userId: string, displayName = "Owner") {
  const db = (env as unknown as TestEnv).DB;
  const ts = new Date().toISOString();
  await db.prepare("INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES(?,?,?,?,?)")
    .bind(userId, displayName, "active", ts, ts).run();
}

describe("Identity native profile/avatar", () => {
  it("reads and updates profile, stores private R2 key, and serves stable public avatar URL", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedUser(userId);
    const token = await userToken(privateKey, userId, ["profile:read", "profile:write"]);
    const app = createApp();
    const auth = { authorization: `Bearer ${token}` };

    const initial = await app.request("http://identity.test/api/v1/me", { headers: auth }, bindings(publicKey));
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ data: { id: userId, displayName: "Owner", avatarUrl: null, status: "active" } });

    const updated = await app.request("http://identity.test/api/v1/me", {
      method: "PATCH",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Owner Updated" }),
    }, bindings(publicKey));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ data: { displayName: "Owner Updated" } });

    const form = new FormData();
    form.set("file", new File([new Uint8Array([1, 2, 3])], "avatar.png", { type: "image/png" }));
    const uploaded = await app.request("http://identity.test/api/v1/me/avatar", {
      method: "PUT",
      headers: auth,
      body: form,
    }, bindings(publicKey));
    expect(uploaded.status).toBe(200);
    const uploadedBody = await uploaded.json() as { data: { avatarUrl: string } };
    expect(uploadedBody.data.avatarUrl).toBe(`http://identity.test/assets/users/${userId}/avatar`);

    const db = (env as unknown as TestEnv).DB;
    const row = await db.prepare("SELECT avatar_key avatarKey FROM users WHERE id=?").bind(userId).first<{ avatarKey: string }>();
    expect(row?.avatarKey).toMatch(new RegExp(`^avatars/users/${userId}/.+\\.png$`));
    expect(await (env as unknown as TestEnv).ASSETS.get(row!.avatarKey)).not.toBeNull();

    const publicAvatar = await app.request(uploadedBody.data.avatarUrl, {}, bindings(publicKey));
    expect(publicAvatar.status).toBe(200);
    expect(publicAvatar.headers.get("content-type")).toBe("image/png");
    expect(publicAvatar.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
  });

  it("requires profile:write and rejects Core-only audience at Identity", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    await seedUser(userId);
    const app = createApp();

    const readOnly = await userToken(privateKey, userId, ["profile:read"]);
    const denied = await app.request("http://identity.test/api/v1/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${readOnly}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Denied" }),
    }, bindings(publicKey));
    expect(denied.status).toBe(403);

    const coreOnly = await userToken(privateKey, userId, ["profile:read"], "lifespace-core");
    const wrongAudience = await app.request("http://identity.test/api/v1/me", {
      headers: { authorization: `Bearer ${coreOnly}` },
    }, bindings(publicKey));
    expect(wrongAudience.status).toBe(401);
  });
});

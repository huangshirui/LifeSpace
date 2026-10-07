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

async function token(privateKey: string, userId: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "resources:read",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function get(publicKey: string, accessToken: string, path: string) {
  return createApp().request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

type LookupPayload = {
  data: {
    items: Array<{ id: string; label: string }>;
    nextCursor: string | null;
  };
};

describe("Space Person alternate-name search", () => {
  it("matches active alternate names while keeping displayName as the canonical label", async () => {
    const db = (env as unknown as TestEnv).DB;
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_${suffix}`;
    const clientId = `app_person_name_${suffix}`;
    const spaceId = `spc_${suffix}`;
    const personId = `per_${suffix}`;
    const otherPersonId = `per_other_${suffix}`;
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?)`).bind(spaceId, "Person Name Search", userId, now, now, "UTC"),
      db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, userId, "黄小天", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(otherPersonId, spaceId, null, "天天同学", now, now),
      db.prepare(`INSERT INTO space_person_names(id,space_id,person_id,name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`spn_${suffix}`, spaceId, personId, "小天", now, now),
      db.prepare(`INSERT INTO space_person_names(id,space_id,person_id,name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`spn_harry_${suffix}`, spaceId, personId, "Harry", now, now),
      db.prepare(`INSERT INTO space_person_names(id,space_id,person_id,name,created_at,updated_at,deleted_at)
        VALUES(?,?,?,?,?,?,?)`).bind(`spn_deleted_${suffix}`, spaceId, personId, "旧称呼", now, now, now),
      db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
        VALUES(?,?,?,?,?)`).bind(clientId, "task", "read", "service", "svc_test_admin"),
    ]);

    const accessToken = await token(privateKey, userId, clientId);
    const base = `/api/v1/spaces/${spaceId}/_relation-targets/task/assigneePersonIds`;

    const alias = await get(publicKey, accessToken, `${base}?q=${encodeURIComponent("小天")}`);
    expect(alias.status).toBe(200);
    expect((await alias.json<LookupPayload>()).data.items).toEqual([{ id: personId, label: "黄小天" }]);

    const latinAlias = await get(publicKey, accessToken, `${base}?q=harry`);
    expect(latinAlias.status).toBe(200);
    expect((await latinAlias.json<LookupPayload>()).data.items).toEqual([{ id: personId, label: "黄小天" }]);

    const deletedAlias = await get(publicKey, accessToken, `${base}?q=${encodeURIComponent("旧称呼")}`);
    expect(deletedAlias.status).toBe(200);
    expect((await deletedAlias.json<LookupPayload>()).data.items).toEqual([]);

    const canonical = await get(publicKey, accessToken, `${base}?q=${encodeURIComponent("黄小")}`);
    expect(canonical.status).toBe(200);
    expect((await canonical.json<LookupPayload>()).data.items).toEqual([{ id: personId, label: "黄小天" }]);
  });
});

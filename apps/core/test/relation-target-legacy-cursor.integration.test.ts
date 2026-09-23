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

function base64Url(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("Relation target cursor compatibility", () => {
  it("accepts a Kernel 0.23 Person cursor that predates targetModel", async () => {
    const db = (env as unknown as TestEnv).DB;
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const privateKey = pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const publicKey = pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey));
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_legacy_cursor_${suffix}`;
    const clientId = `app_legacy_cursor_${suffix}`;
    const spaceId = `spc_legacy_cursor_${suffix}`;
    const betaId = `per_beta_${suffix}`;
    const zuluId = `per_zulu_${suffix}`;
    const now = new Date().toISOString();

    await db.batch([
      db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
        VALUES(?,?,?,?,?,?)`).bind(spaceId, "Legacy Cursor", userId, now, now, "UTC"),
      db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(`per_owner_${suffix}`, spaceId, userId, "Alpha Owner", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(betaId, spaceId, null, "Beta Person", now, now),
      db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).bind(zuluId, spaceId, null, "Zulu Person", now, now),
      db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
        VALUES(?,?,?,?,?)`).bind(clientId, "task", "read", "service", "svc_cursor_test"),
    ]);

    const iat = Math.floor(Date.now() / 1000);
    const accessToken = await sign({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: userId,
      azp: clientId,
      principal_type: "user",
      scope: "resources:read",
      iat,
      exp: iat + 900,
      jti: `tok_${suffix}`,
    }, privateKey, "RS256");

    const legacyCursor = base64Url({
      v: 1,
      kind: "person",
      spaceId,
      modelKey: "task",
      fieldKey: "assigneePersonIds",
      q: null,
      label: "Beta Person",
      id: betaId,
    });
    const response = await createApp().request(
      `http://localhost/api/v1/spaces/${spaceId}/_relation-targets/task/assigneePersonIds?limit=1&cursor=${encodeURIComponent(legacyCursor)}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
      { DB: db, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" },
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{ data: { items: Array<{ id: string; label: string }> } }>();
    expect(payload.data.items).toEqual([{ id: zuluId, label: "Zulu Person" }]);
  });
});

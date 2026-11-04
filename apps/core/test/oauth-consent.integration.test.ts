import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type KeyPair = { privateKey: string; publicKey: string };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  return `-----BEGIN ${label}-----\n${btoa(binary).match(/.{1,64}/g)?.join("\n") ?? ""}\n-----END ${label}-----`;
}
async function keys(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}
async function token(
  key: string, userId: string, applicationId: string, scope = "spaces:manage",
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity", aud: ["lifespace-core", "lifespace-identity"],
    sub: userId, azp: applicationId, principal_type: "user", scope,
    iat, exp: iat + 300, jti: "tok_" + crypto.randomUUID(),
  }, key, "RS256");
}

async function fixture(role: "owner" | "viewer" = "owner") {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = "usr_oauth_" + suffix;
  const appId = "app_account_" + suffix;
  const spaceId = "spc_oauth_" + suffix;
  const agentId = "agt_oauth_" + suffix;
  const targetApp = "app_business_" + suffix;
  const requestId = "oar_" + suffix;
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(spaceId, "OAuth consent test", userId, now, now, "UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind("mem_" + suffix, spaceId, userId, role, now, now),
  ]);
  const pair = await keys();
  const bearer = await token(pair.privateKey, userId, appId);
  const forwarded: Array<{ url: string; secret: string; body: Record<string, unknown> }> = [];
  let upstreamStatus = 200;
  let upstreamPayload: Record<string, unknown> = {
    authorization_id: "oaz_" + suffix,
    redirect_url: "https://client.example.test/callback?code=lsp_oac_sample&state=opaque",
  };
  const bindings = {
    DB: db,
    IDENTITY_PUBLIC_KEY: pair.publicKey,
    OAUTH_ACCOUNT_APPLICATION_ID: appId,
    OAUTH_CORE_APPROVER_SECRET: "core-approval-secret-test",
    IDENTITY: {
      fetch: async (address: string, init?: RequestInit) => {
        forwarded.push({
          url: address,
          secret: new Headers(init?.headers).get("x-lifespace-oauth-approver-secret") ?? "",
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json(upstreamPayload, { status: upstreamStatus });
      },
    } as unknown as Fetcher,
    ENVIRONMENT: "test",
  };
  const selected = { applicationId: targetApp, spaceId, agentId, allowUserAuthorization: true };
  const call = (suppliedToken = bearer, body: unknown = selected, id = requestId) =>
    createApp().request("https://core.example.test/api/v1/me/oauth/requests/" + id + "/confirm", {
      method: "POST", headers: { authorization: "Bearer " + suppliedToken, "content-type": "application/json" },
      body: JSON.stringify(body),
    }, bindings);
  return { userId, appId, spaceId, agentId, requestId, pair, db, bearer, bindings, selected, forwarded, call,
    changeUpstream(status: number, payload: Record<string, unknown> = upstreamPayload) {
      upstreamStatus = status; upstreamPayload = payload;
    },
  };
}

describe("Core Account OAuth Consent boundary", () => {
  it("requires a verified Account user, current Space manage permission and a dedicated Core-to-Identity secret", async () => {
    const f = await fixture();
    const confirmed = await f.call();
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({
      data: { authorizationId: expect.stringMatching(/^oaz_/), redirectUrl: expect.stringContaining("code=lsp_oac_") },
    });
    expect(confirmed.headers.get("cache-control")).toBe("no-store");
    expect(f.forwarded).toHaveLength(1);
    expect(f.forwarded[0]).toMatchObject({
      url: "https://identity.internal/oauth/requests/" + f.requestId + "/approve",
      secret: "core-approval-secret-test",
      body: { userToken: f.bearer, ...f.selected },
    });

    const alienApp = await token(f.pair.privateKey, f.userId, "app_untrusted");
    expect((await f.call(alienApp)).status).toBe(403);
    const underScoped = await token(f.pair.privateKey, f.userId, f.appId, "spaces:read");
    expect((await f.call(underScoped)).status).toBe(403);
    const otherUser = await token(f.pair.privateKey, "usr_other", f.appId);
    expect((await f.call(otherUser)).status).toBe(403);
    expect((await f.call(f.bearer, { ...f.selected, principalUserId: f.userId })).status).toBe(400);
    expect((await f.call(f.bearer, f.selected, "not-an-oar")).status).toBe(400);
    expect(f.forwarded).toHaveLength(1);

    await f.db.prepare("UPDATE space_memberships SET role='viewer' WHERE space_id=? AND user_id=?")
      .bind(f.spaceId, f.userId).run();
    expect((await f.call()).status).toBe(403);
    expect(f.forwarded).toHaveLength(1);
  });

  it("denies non-manager consent, unavailable Service Binding, Identity rejection and malformed code redirect", async () => {
    const viewer = await fixture("viewer");
    expect((await viewer.call()).status).toBe(403);
    expect(viewer.forwarded).toHaveLength(0);

    const owner = await fixture();
    owner.bindings.OAUTH_CORE_APPROVER_SECRET = "";
    expect((await owner.call()).status).toBe(503);
    expect(owner.forwarded).toHaveLength(0);

    owner.bindings.OAUTH_CORE_APPROVER_SECRET = "core-approval-secret-test";
    owner.changeUpstream(403, { error: "access_denied" });
    expect((await owner.call()).status).toBe(403);

    owner.changeUpstream(200, { authorization_id: "oaz_test", redirect_url: "javascript:alert(1)" });
    expect((await owner.call()).status).toBe(502);
    owner.changeUpstream(200, { authorization_id: "oaz_test", redirect_url: "https://client.example.test/callback" });
    expect((await owner.call()).status).toBe(502);
  });
});

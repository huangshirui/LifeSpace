import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";

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

const ACCESS_TEAM_DOMAIN = "https://audience-rebinding.cloudflareaccess.com";
const BOOTSTRAP_SECRET = "bootstrap-test";

async function request(path: string, options: RequestInit, pair: Awaited<ReturnType<typeof keys>>) {
  return createIdentityApp().request(`http://localhost${path}`, options, {
    DB: (env as unknown as TestEnv).DB,
    BOOTSTRAP_SECRET,
    TOKEN_PRIVATE_KEY: pair.privateKey,
    TOKEN_PUBLIC_KEY: pair.publicKey,
    ACCESS_TEAM_DOMAIN,
    ENVIRONMENT: "test",
  });
}

const bootstrapHeaders = {
  "content-type": "application/json",
  "x-bootstrap-secret": BOOTSTRAP_SECRET,
};

async function bootstrapApplication(pair: Awaited<ReturnType<typeof keys>>, applicationId: string, scopes: string[] = ["profile:read"]) {
  const response = await request("/bootstrap/v1/applications", {
    method: "POST",
    headers: bootstrapHeaders,
    body: JSON.stringify({
      id: applicationId,
      name: applicationId,
      trustedBackend: true,
      allowedScopes: scopes,
      accessTokenTtlSeconds: 900,
    }),
  }, pair);
  expect(response.status).toBe(201);
  return ((await response.json()) as any).data.clientSecret as string;
}

async function provisionConsole(pair: Awaited<ReturnType<typeof keys>>) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const applicationId = `app_console_rebind_${suffix}`;
  const applicationSecret = await bootstrapApplication(pair, applicationId, ["platform:admin", "applications:manage", "audit:read"]);

  const user = await request("/internal/v1/users", {
    method: "POST",
    headers: { authorization: `Bearer ${applicationSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ displayName: "Audience Rebinding Operator" }),
  }, pair);
  expect(user.status).toBe(201);
  const userId = ((await user.json()) as any).data.id as string;
  await (env as unknown as TestEnv).DB.prepare(`INSERT INTO platform_administrators(user_id,status,assigned_at,revoked_at)
    VALUES(?,'active',?,NULL)`).bind(userId, new Date().toISOString()).run();

  const session = await request("/internal/v1/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${applicationSecret}`, "content-type": "application/json" },
    body: JSON.stringify({ subjectId: userId, scopes: [] }),
  }, pair);
  expect(session.status).toBe(200);
  const sessionToken = ((await session.json()) as any).data.accessToken as string;

  const actor = await request("/api/v1/me/platform-admin-actor-token", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  }, pair);
  expect(actor.status).toBe(200);
  const actorToken = ((await actor.json()) as any).data.actorToken as string;
  return { applicationId, applicationSecret, actorToken };
}

function adminHeaders(secret: string, actorToken: string) {
  return {
    authorization: `Bearer ${secret}`,
    "x-lifespace-actor-token": actorToken,
    "content-type": "application/json",
  };
}

describe("Cloudflare Access audience rebinding", () => {
  it("keeps revoked bootstrap history while allowing the same audience to move to another application", async () => {
    const pair = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const appA = `app_rebind_a_${suffix}`;
    const appB = `app_rebind_b_${suffix}`;
    const audience = `aud-rebind-${suffix}`;
    await bootstrapApplication(pair, appA);
    await bootstrapApplication(pair, appB);

    const first = await request(`/bootstrap/v1/applications/${appA}/access-audiences`, {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(first.status).toBe(201);
    const firstRow = (await first.json() as any).data;

    const conflict = await request(`/bootstrap/v1/applications/${appB}/access-audiences`, {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).error.code).toBe("ACCESS_AUDIENCE_IN_USE");

    const revoke = await request(`/bootstrap/v1/applications/${appA}/access-audiences/${firstRow.id}`, {
      method: "DELETE",
      headers: { "x-bootstrap-secret": BOOTSTRAP_SECRET },
    }, pair);
    expect(revoke.status).toBe(204);

    const rebound = await request(`/bootstrap/v1/applications/${appB}/access-audiences`, {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(rebound.status).toBe(201);
    const reboundRow = (await rebound.json() as any).data;
    expect(reboundRow.id).not.toBe(firstRow.id);
    expect(reboundRow).toMatchObject({ applicationId: appB, audience, status: "active", revokedAt: null });

    const idempotent = await request(`/bootstrap/v1/applications/${appB}/access-audiences`, {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(idempotent.status).toBe(200);
    expect((await idempotent.json() as any).data.id).toBe(reboundRow.id);

    const rows = await (env as unknown as TestEnv).DB.prepare(`SELECT id,application_id applicationId,status,revoked_at revokedAt
      FROM access_audiences WHERE issuer=? AND audience=? ORDER BY created_at,id`).bind(ACCESS_TEAM_DOMAIN, audience)
      .all<{ id: string; applicationId: string; status: string; revokedAt: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.find((row) => row.id === firstRow.id)).toMatchObject({ applicationId: appA, status: "revoked" });
    expect(rows.results.find((row) => row.id === reboundRow.id)).toMatchObject({ applicationId: appB, status: "active", revokedAt: null });
  });

  it("supports the same revoke-then-rebind lifecycle through Platform Admin and audits both lifecycles", async () => {
    const pair = await keys();
    const console = await provisionConsole(pair);
    const headers = adminHeaders(console.applicationSecret, console.actorToken);

    async function createManagedApplication(name: string) {
      const response = await request("/internal/v1/platform-admin/applications", {
        method: "POST",
        headers,
        body: JSON.stringify({ name, trustedBackend: true, allowedScopes: ["profile:read"], accessTokenTtlSeconds: 900 }),
      }, pair);
      expect(response.status).toBe(201);
      return (await response.json() as any).data.id as string;
    }

    const suffix = crypto.randomUUID().replaceAll("-", "");
    const appA = await createManagedApplication(`Audience A ${suffix}`);
    const appB = await createManagedApplication(`Audience B ${suffix}`);
    const audience = `aud-admin-rebind-${suffix}`;

    const first = await request(`/internal/v1/platform-admin/applications/${appA}/access-audiences`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(first.status).toBe(201);
    const firstRow = (await first.json() as any).data;

    const activeConflict = await request(`/internal/v1/platform-admin/applications/${appB}/access-audiences`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(activeConflict.status).toBe(409);
    expect((await activeConflict.json() as any).error.code).toBe("ACCESS_AUDIENCE_IN_USE");

    const revoke = await request(`/internal/v1/platform-admin/applications/${appA}/access-audiences/${firstRow.id}`, {
      method: "DELETE",
      headers,
    }, pair);
    expect(revoke.status).toBe(204);

    const rebound = await request(`/internal/v1/platform-admin/applications/${appB}/access-audiences`, {
      method: "POST",
      headers,
      body: JSON.stringify({ audience }),
    }, pair);
    expect(rebound.status).toBe(201);
    const reboundRow = (await rebound.json() as any).data;
    expect(reboundRow.id).not.toBe(firstRow.id);
    expect(reboundRow).toMatchObject({ applicationId: appB, audience, status: "active" });

    const oldList = await request(`/internal/v1/platform-admin/applications/${appA}/access-audiences`, {
      method: "GET",
      headers,
    }, pair);
    expect(oldList.status).toBe(200);
    expect((await oldList.json() as any).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstRow.id, applicationId: appA, audience, status: "revoked" }),
    ]));

    const newList = await request(`/internal/v1/platform-admin/applications/${appB}/access-audiences`, {
      method: "GET",
      headers,
    }, pair);
    expect(newList.status).toBe(200);
    expect((await newList.json() as any).data).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: reboundRow.id, applicationId: appB, audience, status: "active" }),
    ]));

    const audit = await request("/internal/v1/platform-admin/audit?limit=100", {
      method: "GET",
      headers,
    }, pair);
    expect(audit.status).toBe(200);
    const entries = (await audit.json() as any).data as any[];
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "access_audience.revoke", targetId: firstRow.id }),
      expect.objectContaining({ operation: "access_audience.create", targetId: reboundRow.id }),
    ]));
  });
});

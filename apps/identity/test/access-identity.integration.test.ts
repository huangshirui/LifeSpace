import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";

type TestEnv = { DB: D1Database };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodePayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
  return JSON.parse(atob(normalized));
}

async function rsaPair() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    pair,
    privatePem: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicPem: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function accessKey() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  const kid = `kid-${crypto.randomUUID()}`;
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { pair, publicJwk, kid };
}

async function accessToken(
  privateKey: CryptoKey,
  kid: string,
  issuer: string,
  subject: string,
  audience: string,
  email = "same@example.com",
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = base64Url(JSON.stringify({
    iss: issuer,
    sub: subject,
    aud: [audience],
    email,
    type: "app",
    iat: now,
    nbf: now - 1,
    exp: now + 600,
  }));
  const input = `${head}.${body}`;
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, new TextEncoder().encode(input));
  return `${input}.${base64Url(signature)}`;
}

describe("Cloudflare Access Identity integration", () => {
  it("binds audiences to application subjects, links existing users, supports multiple principals, and never merges by email", async () => {
    const db = (env as unknown as TestEnv).DB;
    const issuer = "https://access-integration.cloudflareaccess.com";
    const access = await accessKey();
    const life = await rsaPair();
    const fetcher = async () => new Response(JSON.stringify({ keys: [access.publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const app = createIdentityApp({ accessFetch: fetcher as typeof fetch });
    const bindings = {
      DB: db,
      BOOTSTRAP_SECRET: "bootstrap-test",
      TOKEN_PRIVATE_KEY: life.privatePem,
      TOKEN_PUBLIC_KEY: life.publicPem,
      ACCESS_TEAM_DOMAIN: issuer,
      ENVIRONMENT: "test",
    } as any;
    const request = (path: string, options: RequestInit) => app.request(`http://localhost${path}`, options, bindings);
    const jsonHeaders = { "content-type": "application/json" };
    const bootstrapHeaders = { ...jsonHeaders, "x-bootstrap-secret": "bootstrap-test" };

    async function bootstrapApp(appId: string) {
      const response = await request("/bootstrap/v1/applications", {
        method: "POST",
        headers: bootstrapHeaders,
        body: JSON.stringify({
          id: appId,
          name: appId,
          trustedBackend: true,
          allowedScopes: ["spaces:read", "profile:read"],
          accessTokenTtlSeconds: 900,
        }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as any).data.clientSecret as string;
    }

    async function registerAudience(appId: string, audience: string) {
      const response = await request(`/bootstrap/v1/applications/${appId}/access-audiences`, {
        method: "POST",
        headers: bootstrapHeaders,
        body: JSON.stringify({ audience }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as any).data.id as string;
    }

    const suffix = crypto.randomUUID();
    const homeAppId = `test-home-a-${suffix}`;
    const otherAppId = `test-home-b-${suffix}`;
    const providerAppId = `test-provider-${suffix}`;
    const homeAudience = `aud-home-${suffix}`;
    const otherAudience = `aud-other-${suffix}`;
    const homeSecret = await bootstrapApp(homeAppId);
    const otherSecret = await bootstrapApp(otherAppId);
    const providerSecret = await bootstrapApp(providerAppId);
    await registerAudience(homeAppId, homeAudience);
    await registerAudience(otherAppId, otherAudience);

    const duplicateAudience = await request(`/bootstrap/v1/applications/${otherAppId}/access-audiences`, {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({ audience: homeAudience }),
    });
    expect(duplicateAudience.status).toBe(409);

    const subject1 = `access-existing-${suffix}`;
    const assertion1 = await accessToken(access.pair.privateKey, access.kid, issuer, subject1, homeAudience);
    const unlinked = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1, requestedScopes: ["spaces:read"] }),
    });
    expect(unlinked.status).toBe(409);
    expect(((await unlinked.json()) as any).error.code).toBe("ACCESS_PRINCIPAL_UNLINKED");

    const createUser = await request("/internal/v1/users", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${providerSecret}` },
      body: JSON.stringify({ displayName: "Existing Provider User" }),
    });
    expect(createUser.status).toBe(201);
    const existingUserId = ((await createUser.json()) as any).data.id as string;
    const providerTokenResponse = await request("/internal/v1/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${providerSecret}` },
      body: JSON.stringify({ subjectId: existingUserId, scopes: [] }),
    });
    const providerUserToken = ((await providerTokenResponse.json()) as any).data.accessToken as string;

    const challenge = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1 }),
    });
    expect(challenge.status).toBe(201);
    const linkId = ((await challenge.json()) as any).data.challengeId as string;
    const confirm = await request(`/api/v1/me/access-link-challenges/${linkId}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${providerUserToken}` },
    });
    expect(confirm.status).toBe(204);

    const secondConfirm = await request(`/api/v1/me/access-link-challenges/${linkId}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${providerUserToken}` },
    });
    expect(secondConfirm.status).toBe(409);

    const linkedExchange = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1, requestedScopes: ["spaces:read"] }),
    });
    expect(linkedExchange.status).toBe(200);
    const linkedToken = ((await linkedExchange.json()) as any).data.accessToken as string;
    expect(decodePayload(linkedToken)).toMatchObject({ sub: existingUserId, azp: homeAppId, principal_type: "user" });

    const mismatchedApp = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${otherSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1, requestedScopes: ["spaces:read"] }),
    });
    expect(mismatchedApp.status).toBe(403);
    expect(((await mismatchedApp.json()) as any).error.code).toBe("ACCESS_AUDIENCE_MISMATCH");

    const assertionForOtherApp = await accessToken(access.pair.privateKey, access.kid, issuer, subject1, otherAudience);
    const samePrincipalOtherAudience = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${otherSecret}` },
      body: JSON.stringify({ accessAssertion: assertionForOtherApp, requestedScopes: ["spaces:read"] }),
    });
    expect(samePrincipalOtherAudience.status).toBe(200);
    expect(decodePayload(((await samePrincipalOtherAudience.json()) as any).data.accessToken)).toMatchObject({
      sub: existingUserId,
      azp: otherAppId,
    });

    const subject2 = `access-new-${suffix}`;
    // An unreserved mailbox cannot resolve an unknown Access subject to an existing user.
    const sameEmailAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, subject2, homeAudience, "unclaimed@example.com");
    const stillUnlinked = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({ accessAssertion: sameEmailAssertion, requestedScopes: [] }),
    });
    expect(stillUnlinked.status).toBe(409);

    const registration = await request("/internal/v1/access/registrations", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({
        accessAssertion: sameEmailAssertion,
        displayName: "Explicit New Access User",
        requestedScopes: ["profile:read"],
      }),
    });
    expect(registration.status).toBe(201);
    const newUserId = ((await registration.json()) as any).data.user.id as string;
    expect(newUserId).not.toBe(existingUserId);

    const subject3 = `access-second-principal-${suffix}`;
    const secondPrincipalAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, subject3, homeAudience, "other@example.com");
    const secondChallenge = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({ accessAssertion: secondPrincipalAssertion }),
    });
    const secondChallengeId = ((await secondChallenge.json()) as any).data.challengeId as string;
    expect((await request(`/api/v1/me/access-link-challenges/${secondChallengeId}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${providerUserToken}` },
    })).status).toBe(204);

    const linkedRows = await db.prepare(`
      SELECT subject,user_id userId,email_snapshot email
      FROM access_principals WHERE issuer=? AND subject IN (?,?,?) ORDER BY subject
    `).bind(issuer, subject1, subject2, subject3).all<{ subject: string; userId: string; email: string | null }>();
    expect(linkedRows.results).toHaveLength(3);
    expect(linkedRows.results.filter((row) => row.userId === existingUserId)).toHaveLength(2);
    expect(linkedRows.results.find((row) => row.subject === subject2)?.userId).toBe(newUserId);

    const expiringSubject = `access-expiring-${suffix}`;
    const expiringAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, expiringSubject, homeAudience);
    const expiringChallenge = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${homeSecret}` },
      body: JSON.stringify({ accessAssertion: expiringAssertion }),
    });
    const expiringId = ((await expiringChallenge.json()) as any).data.challengeId as string;
    await db.prepare("UPDATE access_link_challenges SET expires_at=? WHERE id=?")
      .bind("2000-01-01T00:00:00.000Z", expiringId).run();
    const expiredConfirm = await request(`/api/v1/me/access-link-challenges/${expiringId}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${providerUserToken}` },
    });
    expect(expiredConfirm.status).toBe(409);
  });
});

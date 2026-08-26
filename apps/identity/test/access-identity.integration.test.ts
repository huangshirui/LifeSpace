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
  it("links by short scan token, keeps tokens hashed, rejects cross-user races, supports multiple principals, and never merges by email", async () => {
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

    async function bootstrapApp(appId: string, clientType: "web" | "mini_program") {
      const response = await request("/bootstrap/v1/applications", {
        method: "POST",
        headers: bootstrapHeaders,
        body: JSON.stringify({
          id: appId,
          name: appId,
          clientType,
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

    async function createMiniUser(displayName: string) {
      const createUser = await request("/internal/v1/users", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${miniSecret}` },
        body: JSON.stringify({ displayName }),
      });
      expect(createUser.status).toBe(201);
      const userId = ((await createUser.json()) as any).data.id as string;
      const tokenResponse = await request("/internal/v1/tokens", {
        method: "POST",
        headers: { ...jsonHeaders, authorization: `Bearer ${miniSecret}` },
        body: JSON.stringify({ subjectId: userId, scopes: [] }),
      });
      expect(tokenResponse.status).toBe(200);
      return {
        userId,
        token: ((await tokenResponse.json()) as any).data.accessToken as string,
      };
    }

    const suffix = crypto.randomUUID();
    const webAppId = `homemew-web-${suffix}`;
    const otherWebAppId = `aloha-web-${suffix}`;
    const miniAppId = `homemew-mini-${suffix}`;
    const homeAudience = `aud-home-${suffix}`;
    const otherAudience = `aud-other-${suffix}`;
    const webSecret = await bootstrapApp(webAppId, "web");
    const otherWebSecret = await bootstrapApp(otherWebAppId, "web");
    const miniSecret = await bootstrapApp(miniAppId, "mini_program");
    await registerAudience(webAppId, homeAudience);
    await registerAudience(otherWebAppId, otherAudience);

    const duplicateAudience = await request(`/bootstrap/v1/applications/${otherWebAppId}/access-audiences`, {
      method: "POST",
      headers: bootstrapHeaders,
      body: JSON.stringify({ audience: homeAudience }),
    });
    expect(duplicateAudience.status).toBe(409);

    const existingMiniUser = await createMiniUser("Existing Mini User");
    const rivalMiniUser = await createMiniUser("Rival Mini User");

    const raceSubject = `access-race-${suffix}`;
    const raceAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, raceSubject, homeAudience, "race@example.com");
    const raceChallengeA = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: raceAssertion }),
    });
    const raceChallengeB = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: raceAssertion }),
    });
    expect(raceChallengeA.status).toBe(201);
    expect(raceChallengeB.status).toBe(201);
    const raceScanA = ((await raceChallengeA.json()) as any).data.scanToken as string;
    const raceScanB = ((await raceChallengeB.json()) as any).data.scanToken as string;
    expect((await request(`/api/v1/me/access-link-scan-tokens/${encodeURIComponent(raceScanA)}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${existingMiniUser.token}` },
    })).status).toBe(204);
    const losingRace = await request(`/api/v1/me/access-link-scan-tokens/${encodeURIComponent(raceScanB)}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${rivalMiniUser.token}` },
    });
    expect(losingRace.status).toBe(409);
    expect(((await losingRace.json()) as any).error.code).toBe("ACCESS_PRINCIPAL_ALREADY_LINKED");
    const racePrincipal = await db.prepare("SELECT user_id userId FROM access_principals WHERE issuer=? AND subject=?")
      .bind(issuer, raceSubject).first<{ userId: string }>();
    expect(racePrincipal?.userId).toBe(existingMiniUser.userId);

    const subject1 = `access-existing-${suffix}`;
    const assertion1 = await accessToken(access.pair.privateKey, access.kid, issuer, subject1, homeAudience);
    const unlinked = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1, requestedScopes: ["spaces:read"] }),
    });
    expect(unlinked.status).toBe(409);
    expect(((await unlinked.json()) as any).error.code).toBe("ACCESS_PRINCIPAL_UNLINKED");

    const challenge = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1 }),
    });
    expect(challenge.status).toBe(201);
    const challengeData = ((await challenge.json()) as any).data;
    const linkId = challengeData.challengeId as string;
    const scanToken = challengeData.scanToken as string;
    expect(linkId).toMatch(/^alc_[0-9a-f]{64}$/u);
    expect(scanToken).toMatch(/^als_[A-Za-z0-9_-]{24}$/u);
    expect(scanToken.length).toBeLessThanOrEqual(32);

    const persistedScan = await db.prepare("SELECT scan_token_hash scanTokenHash FROM access_link_challenges WHERE id=?")
      .bind(linkId).first<{ scanTokenHash: string | null }>();
    expect(persistedScan?.scanTokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(persistedScan?.scanTokenHash).not.toContain(scanToken);

    const confirm = await request(`/api/v1/me/access-link-scan-tokens/${encodeURIComponent(scanToken)}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${existingMiniUser.token}` },
    });
    expect(confirm.status).toBe(204);

    const secondConfirm = await request(`/api/v1/me/access-link-scan-tokens/${encodeURIComponent(scanToken)}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${existingMiniUser.token}` },
    });
    expect(secondConfirm.status).toBe(409);

    const linkedExchange = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1, requestedScopes: ["spaces:read"] }),
    });
    expect(linkedExchange.status).toBe(200);
    const linkedToken = ((await linkedExchange.json()) as any).data.accessToken as string;
    expect(decodePayload(linkedToken)).toMatchObject({ sub: existingMiniUser.userId, azp: webAppId, principal_type: "user" });

    const mismatchedApp = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${otherWebSecret}` },
      body: JSON.stringify({ accessAssertion: assertion1, requestedScopes: ["spaces:read"] }),
    });
    expect(mismatchedApp.status).toBe(403);
    expect(((await mismatchedApp.json()) as any).error.code).toBe("ACCESS_AUDIENCE_MISMATCH");

    const assertionForOtherApp = await accessToken(access.pair.privateKey, access.kid, issuer, subject1, otherAudience);
    const samePrincipalOtherAudience = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${otherWebSecret}` },
      body: JSON.stringify({ accessAssertion: assertionForOtherApp, requestedScopes: ["spaces:read"] }),
    });
    expect(samePrincipalOtherAudience.status).toBe(200);
    expect(decodePayload(((await samePrincipalOtherAudience.json()) as any).data.accessToken)).toMatchObject({
      sub: existingMiniUser.userId,
      azp: otherWebAppId,
    });

    const subject2 = `access-new-${suffix}`;
    const sameEmailAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, subject2, homeAudience, "same@example.com");
    const stillUnlinked = await request("/internal/v1/access/tokens", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: sameEmailAssertion, requestedScopes: [] }),
    });
    expect(stillUnlinked.status).toBe(409);

    const registration = await request("/internal/v1/access/registrations", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({
        accessAssertion: sameEmailAssertion,
        displayName: "Explicit New Web User",
        requestedScopes: ["profile:read"],
      }),
    });
    expect(registration.status).toBe(201);
    const registrationData = ((await registration.json()) as any).data;
    const newUserId = registrationData.user.id as string;
    expect(newUserId).not.toBe(existingMiniUser.userId);

    const subject3 = `access-second-principal-${suffix}`;
    const secondPrincipalAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, subject3, homeAudience, "other@example.com");
    const secondChallenge = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: secondPrincipalAssertion }),
    });
    const secondChallengeId = ((await secondChallenge.json()) as any).data.challengeId as string;
    expect((await request(`/api/v1/me/access-link-challenges/${secondChallengeId}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${existingMiniUser.token}` },
    })).status).toBe(204);

    const linkedRows = await db.prepare(`
      SELECT subject,user_id userId,email_snapshot email
      FROM access_principals WHERE issuer=? AND subject IN (?,?,?) ORDER BY subject
    `).bind(issuer, subject1, subject2, subject3).all<{ subject: string; userId: string; email: string | null }>();
    expect(linkedRows.results).toHaveLength(3);
    expect(linkedRows.results.filter((row) => row.userId === existingMiniUser.userId)).toHaveLength(2);
    expect(linkedRows.results.find((row) => row.subject === subject2)?.userId).toBe(newUserId);

    const expiringSubject = `access-expiring-${suffix}`;
    const expiringAssertion = await accessToken(access.pair.privateKey, access.kid, issuer, expiringSubject, homeAudience);
    const expiringChallenge = await request("/internal/v1/access/link-challenges", {
      method: "POST",
      headers: { ...jsonHeaders, authorization: `Bearer ${webSecret}` },
      body: JSON.stringify({ accessAssertion: expiringAssertion }),
    });
    const expiringData = ((await expiringChallenge.json()) as any).data;
    const expiringId = expiringData.challengeId as string;
    const expiringScanToken = expiringData.scanToken as string;
    await db.prepare("UPDATE access_link_challenges SET expires_at=? WHERE id=?")
      .bind("2000-01-01T00:00:00.000Z", expiringId).run();
    const expiredConfirm = await request(`/api/v1/me/access-link-scan-tokens/${encodeURIComponent(expiringScanToken)}/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${existingMiniUser.token}` },
    });
    expect(expiredConfirm.status).toBe(409);
  });
});

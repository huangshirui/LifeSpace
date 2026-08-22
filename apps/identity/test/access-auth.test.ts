import { describe, expect, it } from "vitest";
import { AccessAssertionError, verifyAccessAssertion } from "../src/access-auth";

function base64Url(value: string | ArrayBuffer): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

async function accessKey(kid = `kid-${crypto.randomUUID()}`) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey) as JsonWebKey & { kid?: string; alg?: string; use?: string };
  publicJwk.kid = kid;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  return { pair, publicJwk, kid };
}

async function signAccessToken(
  privateKey: CryptoKey,
  kid: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64Url(signature)}`;
}

describe("Cloudflare Access JWT verifier", () => {
  it("verifies RS256, configured issuer, lifetime, subject and audience", async () => {
    const issuer = `https://${crypto.randomUUID()}.cloudflareaccess.com`;
    const key = await accessKey();
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(key.pair.privateKey, key.kid, {
      iss: issuer,
      sub: "access-user-1",
      aud: ["aud-home"],
      email: "person@example.com",
      type: "app",
      iat: now,
      nbf: now - 1,
      exp: now + 300,
    });
    const fetcher = async () => new Response(JSON.stringify({ keys: [key.publicJwk] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(verifyAccessAssertion(token, { teamDomain: issuer, fetcher: fetcher as typeof fetch, nowSeconds: now })).resolves.toEqual({
      issuer,
      subject: "access-user-1",
      audiences: ["aud-home"],
      email: "person@example.com",
      expiresAt: now + 300,
    });
  });

  it("rejects issuer, expiry and signature failures", async () => {
    const issuer = `https://${crypto.randomUUID()}.cloudflareaccess.com`;
    const key = await accessKey();
    const now = Math.floor(Date.now() / 1000);
    const fetcher = async () => new Response(JSON.stringify({ keys: [key.publicJwk] }), { status: 200 });

    const wrongIssuer = await signAccessToken(key.pair.privateKey, key.kid, {
      iss: "https://wrong.cloudflareaccess.com",
      sub: "user",
      aud: ["aud"],
      exp: now + 300,
    });
    await expect(verifyAccessAssertion(wrongIssuer, { teamDomain: issuer, fetcher: fetcher as typeof fetch, nowSeconds: now }))
      .rejects.toMatchObject({ name: "AccessAssertionError", kind: "invalid" });

    const expired = await signAccessToken(key.pair.privateKey, key.kid, {
      iss: issuer,
      sub: "user",
      aud: ["aud"],
      exp: now,
    });
    await expect(verifyAccessAssertion(expired, { teamDomain: issuer, fetcher: fetcher as typeof fetch, nowSeconds: now }))
      .rejects.toBeInstanceOf(AccessAssertionError);

    const valid = await signAccessToken(key.pair.privateKey, key.kid, {
      iss: issuer,
      sub: "user",
      aud: ["aud"],
      exp: now + 300,
    });
    const [head, body, signature] = valid.split(".");
    const tampered = `${head}.${base64Url(JSON.stringify({ iss: issuer, sub: "attacker", aud: ["aud"], exp: now + 300 }))}.${signature}`;
    await expect(verifyAccessAssertion(tampered, { teamDomain: issuer, fetcher: fetcher as typeof fetch, nowSeconds: now }))
      .rejects.toBeInstanceOf(AccessAssertionError);
  });

  it("forces one JWKS refresh when an assertion uses a rotated kid", async () => {
    const issuer = `https://${crypto.randomUUID()}.cloudflareaccess.com`;
    const oldKey = await accessKey("old-key");
    const newKey = await accessKey("new-key");
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(newKey.pair.privateKey, newKey.kid, {
      iss: issuer,
      sub: "rotated-user",
      aud: ["aud"],
      exp: now + 300,
    });
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return new Response(JSON.stringify({ keys: calls === 1 ? [oldKey.publicJwk] : [newKey.publicJwk] }), { status: 200 });
    };

    await expect(verifyAccessAssertion(token, { teamDomain: issuer, fetcher: fetcher as typeof fetch, nowSeconds: now }))
      .resolves.toMatchObject({ subject: "rotated-user" });
    expect(calls).toBe(2);
  });
});

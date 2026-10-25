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

describe("explicit mailbox login authorization",()=>{
  it("keeps email as an explicit app-scoped grant, handles races and revokes old Web access without merging",async()=>{
    const db=(env as unknown as TestEnv).DB, life=await rsaPair(), access=await accessKey();
    const suffix=crypto.randomUUID(), issuer=`https://email-${suffix}.cloudflareaccess.com`;
    const app=createIdentityApp({accessFetch:(async()=>new Response(JSON.stringify({keys:[access.publicJwk]}))) as typeof fetch});
    const bindings={DB:db,BOOTSTRAP_SECRET:"boot-email",TOKEN_PRIVATE_KEY:life.privatePem,TOKEN_PUBLIC_KEY:life.publicPem,ACCESS_TEAM_DOMAIN:issuer} as any;
    const req=(path:string,body?:unknown,token?:string,method=body===undefined?"GET":"POST")=>app.request(`http://localhost${path}`,{
      method,headers:{"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    },bindings);
    const appId=`email-app-${suffix}`,audience=`email-aud-${suffix}`;
    const bootstrap=await app.request("http://localhost/bootstrap/v1/applications",{method:"POST",headers:{"content-type":"application/json","x-bootstrap-secret":"boot-email"},body:JSON.stringify({id:appId,name:"Email test",trustedBackend:true,allowedScopes:["profile:read","profile:write"]})},bindings);
    expect(bootstrap.status).toBe(201);
    const secret=((await bootstrap.json()) as any).data.clientSecret;
    const audienceResponse=await app.request(`http://localhost/bootstrap/v1/applications/${appId}/access-audiences`,{method:"POST",headers:{"content-type":"application/json","x-bootstrap-secret":"boot-email"},body:JSON.stringify({audience})},bindings);
    expect(audienceResponse.status).toBe(201);
    const createUser=async(name:string)=>{
      const result=await req("/internal/v1/users",{displayName:name},secret);
      return ((await result.json()) as any).data.id as string;
    };
    const user=await createUser("One"), other=await createUser("Two");
    const userToken=async(id:string,scopes=["profile:read","profile:write"])=>{
      const result=await req("/internal/v1/tokens",{subjectId:id,scopes},secret);
      return ((await result.json()) as any).data.accessToken as string;
    };
    const token=await userToken(user),otherToken=await userToken(other);
    const email=`one-${suffix}@example.com`, nextEmail=`two-${suffix}@example.com`;
    expect((await req("/api/v1/me/web-login")).status).toBe(401);
    expect((await req("/api/v1/me/web-login",{email,version:0},await userToken(user,["profile:read"]),"PATCH")).status).toBe(403);
    expect((await req("/api/v1/me/web-login",{email:"bad",version:0},token,"PATCH")).status).toBe(422);
    expect((await req("/api/v1/me/web-login",{email,version:0,userId:other},token,"PATCH")).status).toBe(400);
    const empty=await req("/api/v1/me/web-login",undefined,token);
    expect(((await empty.json()) as any).data).toEqual({email:null,version:0,linked:false});
    const save=await req("/api/v1/me/web-login",{email:email.toUpperCase(),version:0},token,"PATCH");
    expect(save.status).toBe(200);
    expect(((await save.json()) as any).data).toMatchObject({email,version:1});
    const current=await req("/api/v1/me/web-login",undefined,token);
    expect(((await current.json()) as any).data).toMatchObject({email,version:1,linked:true});
    expect((await req("/api/v1/me/web-login",{email,version:0},otherToken,"PATCH")).status).toBe(409);
    const assertion=await accessToken(access.pair.privateKey,access.kid,issuer,`new-${suffix}`,audience,email);
    const exchange=await req("/internal/v1/access/tokens",{accessAssertion:assertion,requestedScopes:["profile:read"]},secret);
    expect(exchange.status).toBe(200);
    expect(decodePayload(((await exchange.json()) as any).data.accessToken).sub).toBe(user);
    const check=await req("/internal/v1/access/session-check",{accessAssertion:assertion},secret);
    expect(((await check.json()) as any).data.userId).toBe(user);
    const now=new Date().toISOString();
    await db.prepare("INSERT INTO access_principals(id,issuer,subject,user_id,email_snapshot,status,linked_at,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?)")
      .bind(`acp_${suffix}`,issuer,`legacy-${suffix}`,user,email,now,now,now).run();
    const legacyAssertion=await accessToken(access.pair.privateKey,access.kid,issuer,`legacy-${suffix}`,audience,email);
    expect((await req("/internal/v1/access/session-check",{accessAssertion:legacyAssertion},secret)).status).toBe(200);
    const raced=await Promise.all([
      req("/api/v1/me/web-login",{email:nextEmail,version:1},token,"PATCH"),
      req("/api/v1/me/web-login",{email:`race-${suffix}@example.com`,version:1},token,"PATCH"),
    ]);
    expect(raced.map(r=>r.status).sort()).toEqual([200,409]);
    const saved=((await (await req("/api/v1/me/web-login",undefined,token)).json()) as any).data;
    expect(saved.version).toBe(2);
    expect((await req("/internal/v1/access/session-check",{accessAssertion:legacyAssertion},secret)).status).toBe(403);
    expect((await req("/internal/v1/access/session-check",{accessAssertion:assertion},secret)).status).toBe(409);
    const newAssertion=await accessToken(access.pair.privateKey,access.kid,issuer,`new-email-${suffix}`,audience,saved.email);
    expect((await req("/internal/v1/access/session-check",{accessAssertion:newAssertion},secret)).status).toBe(200);
    expect((await req(`/api/v1/me/access-link-challenges/alc_${"a".repeat(64)}/confirm`,{},token)).status).toBe(409);
    const audit=await db.prepare("SELECT count(*) n FROM web_login_email_audit WHERE user_id=? AND application_id=?").bind(user,appId).first<{n:number}>();
    expect(audit?.n).toBe(2);
    // A matching raw email is not sufficient: the JWT must still verify and match this audience.
    const invalid=await req("/internal/v1/access/session-check",{accessAssertion:"not-a-jwt",email:saved.email},secret);
    expect(invalid.status).toBe(401);
    const foreign=await accessToken(access.pair.privateKey,access.kid,issuer,"foreign",`unknown-audience-${suffix}`,saved.email);
    expect((await req("/internal/v1/access/session-check",{accessAssertion:foreign},secret)).status).toBe(403);
    await db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(user).run();
    expect((await req("/internal/v1/access/session-check",{accessAssertion:newAssertion},secret)).status).toBe(409);
  });
});
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

async function fixture() {
 const db=(env as unknown as TestEnv).DB,life=await rsaPair(),access=await accessKey();
 const suffix=crypto.randomUUID(),issuer=`https://link-${suffix}.cloudflareaccess.com`;
 const app=createIdentityApp({accessFetch:(async()=>new Response(JSON.stringify({keys:[access.publicJwk]}))) as typeof fetch});
 const bindings={DB:db,BOOTSTRAP_SECRET:'link-bootstrap',TOKEN_PRIVATE_KEY:life.privatePem,TOKEN_PUBLIC_KEY:life.publicPem,ACCESS_TEAM_DOMAIN:issuer} as any;
 const req=(path:string,body?:unknown,token?:string,method=body===undefined?'GET':'POST')=>app.request(`http://localhost${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},bindings);
 async function application(label:string) {
  const appId=`link-${label}-${suffix}`,audience=`aud-${label}-${suffix}`;
  const created=await app.request('http://localhost/bootstrap/v1/applications',{method:'POST',headers:{'content-type':'application/json','x-bootstrap-secret':'link-bootstrap'},body:JSON.stringify({id:appId,name:'Link test',trustedBackend:true,allowedScopes:['profile:read','profile:write']})},bindings);
  expect(created.status).toBe(201);const secret=((await created.json()) as any).data.clientSecret;
  const registration=await app.request(`http://localhost/bootstrap/v1/applications/${appId}/access-audiences`,{method:'POST',headers:{'content-type':'application/json','x-bootstrap-secret':'link-bootstrap'},body:JSON.stringify({audience})},bindings);
  expect(registration.status).toBe(201);return {appId,audience,secret};
 }
 const home=await application('home'),other=await application('other');
 async function user(label:string){const r=await req('/internal/v1/users',{displayName:label},home.secret);expect(r.status).toBe(201);return ((await r.json()) as any).data.id as string;}
 async function token(userId:string,scopes=['profile:read','profile:write'],secret=home.secret){const r=await req('/internal/v1/tokens',{subjectId:userId,scopes},secret);expect(r.status).toBe(200);return ((await r.json()) as any).data.accessToken as string;}
 const assertion=(subject:string,email:string,audience=home.audience)=>accessToken(access.pair.privateKey,access.kid,issuer,subject,audience,email);
 const settings=async(t:string)=>((await (await req('/api/v1/me/web-login',undefined,t)).json()) as any).data;
 const save=(t:string,email:string,version:number)=>req('/api/v1/me/web-login',{email,version},t,'PATCH');
 const exchange=(a:string,secret=home.secret)=>req('/internal/v1/access/tokens',{accessAssertion:a,requestedScopes:['profile:read']},secret);
 return {db,req,home,other,user,token,assertion,settings,save,exchange,issuer,suffix};
}

describe('one Access account-link model',()=>{
 it('email-first and code-first complete the same principal record and ordinary subject login',async()=>{
  const f=await fixture(),a=await f.user('Email first'),b=await f.user('Code first'),c=await f.user('Code completes pre-link');
  const ta=await f.token(a),tb=await f.token(b),tc=await f.token(c),emailA=`a-${f.suffix}@example.com`,emailB=`b-${f.suffix}@example.com`;
  expect(await f.settings(ta)).toEqual({email:null,version:0,linked:false,status:'unlinked'});
  expect((await f.save(ta,emailA.toUpperCase(),0)).status).toBe(200);
  expect(await f.settings(ta)).toEqual({email:emailA,version:1,linked:false,status:'pending'});
  const pending=await f.db.prepare('SELECT id,subject FROM access_principals WHERE user_id=?').bind(a).first<any>();
  expect(pending.subject).toBeNull();
  const aa=await f.assertion('email-subject',emailA),login=await f.exchange(aa);
  expect(login.status).toBe(200);expect(decodePayload(((await login.json()) as any).data.accessToken).sub).toBe(a);
  const completed=await f.db.prepare('SELECT id,subject,pending_application_id FROM access_principals WHERE user_id=?').bind(a).first<any>();
  expect(completed).toEqual({id:pending.id,subject:'email-subject',pending_application_id:null});
  expect(await f.settings(ta)).toEqual({email:emailA,version:2,linked:true,status:'linked'});
  // Same mailbox alone can never resolve another subject after completion.
  expect((await f.exchange(await f.assertion('unrelated-subject',emailA))).status).toBe(409);
  const ab=await f.assertion('code-subject',emailB);
  const challenge=await f.req('/internal/v1/access/link-challenges',{accessAssertion:ab},f.home.secret);
  expect(challenge.status).toBe(201);const cid=((await challenge.json()) as any).data.challengeId;
  expect((await f.req(`/api/v1/me/access-link-challenges/${cid}/confirm`,{},tb)).status).toBe(204);
  expect(await f.settings(tb)).toEqual({email:emailB,version:1,linked:true,status:'linked'});
  const lb=await f.exchange(ab);expect(lb.status).toBe(200);expect(decodePayload(((await lb.json()) as any).data.accessToken).sub).toBe(b);
  expect((await f.req(`/api/v1/me/access-link-challenges/${cid}/confirm`,{},tb)).status).toBe(409);
  const emailC=`c-${f.suffix}@example.com`;await f.save(tc,emailC,0);
  const pc=await f.db.prepare('SELECT id FROM access_principals WHERE user_id=?').bind(c).first<any>();
  const challengeC=await f.req('/internal/v1/access/link-challenges',{accessAssertion:await f.assertion('code-pending',emailC)},f.home.secret);
  const cc=((await challengeC.json()) as any).data.challengeId;
  expect((await f.req(`/api/v1/me/access-link-challenges/${cc}/confirm`,{},tc)).status).toBe(204);
  const rowsC=await f.db.prepare('SELECT id,subject FROM access_principals WHERE user_id=?').bind(c).all<any>();
  expect(rowsC.results).toEqual([{id:pc.id,subject:'code-pending'}]);
  const legacyTable=await f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='web_login_emails'").first();expect(legacyTable).toBeNull();
  // Established platform identity remains global; initial pre-link completion is audience-scoped.
  expect((await f.exchange(await f.assertion('email-subject',emailA,f.other.audience),f.other.secret)).status).toBe(200);
 },30000);

 it('keeps version races atomic and rejects conflicting users, unsigned email and wrong audience',async()=>{
  const f=await fixture(),u=await f.user('One'),v=await f.user('Two'),t=await f.token(u),other=await f.token(v),email=`race-${f.suffix}@example.com`;
  expect((await f.req('/api/v1/me/web-login')).status).toBe(401);
  expect((await f.save(await f.token(u,['profile:read']),email,0)).status).toBe(403);
  expect((await f.save(t,'bad',0)).status).toBe(422);
  expect((await f.req('/api/v1/me/web-login',{email,version:0,userId:v},t,'PATCH')).status).toBe(400);
  const raced=await Promise.all([f.save(t,email,0),f.save(t,'other-'+email,0)]);expect(raced.map(x=>x.status).sort()).toEqual([200,409]);
  const settings=await f.settings(t);expect(settings.version).toBe(1);
  expect((await f.db.prepare('SELECT count(*) n FROM access_principals WHERE user_id=?').bind(u).first<any>()).n).toBe(1);
  expect((await f.db.prepare('SELECT count(*) n FROM access_link_audit WHERE user_id=?').bind(u).first<any>()).n).toBe(1);
  expect((await f.save(other,settings.email,0)).status).toBe(409);expect((await f.settings(other)).version).toBe(0);
  const foreign=await f.assertion('foreign',settings.email,f.other.audience);
  expect((await f.exchange(foreign)).status).toBe(403);
  expect((await f.exchange(foreign,f.other.secret)).status).toBe(409);
  expect((await f.req('/internal/v1/access/session-check',{accessAssertion:'invalid',email:settings.email},f.home.secret)).status).toBe(401);
  const valid=await f.assertion('correct',settings.email);expect((await f.exchange(valid)).status).toBe(200);
  await f.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(u).run();
  expect((await f.exchange(valid)).status).toBe(403);
 },30000);

 it('replaces the selected code-linked email and denies its old subject and cached session',async()=>{
  const f=await fixture(),u=await f.user('Replace'),t=await f.token(u),email=`before-${f.suffix}@example.com`,next=`after-${f.suffix}@example.com`;
  const old=await f.assertion('before',email),challenge=await f.req('/internal/v1/access/link-challenges',{accessAssertion:old},f.home.secret);
  const cid=((await challenge.json()) as any).data.challengeId;
  expect((await f.req(`/api/v1/me/access-link-challenges/${cid}/confirm`,{},t)).status).toBe(204);
  const current=await f.settings(t);expect(current.email).toBe(email);
  expect((await f.save(t,next,current.version)).status).toBe(200);
  expect((await f.req('/internal/v1/access/session-check',{accessAssertion:old},f.home.secret)).status).toBe(403);
  expect((await f.exchange(old)).status).toBe(403);
  expect((await f.exchange(await f.assertion('after',next))).status).toBe(200);
  expect((await f.settings(t)).email).toBe(next);
  const latest=await f.settings(t);
  expect((await f.save(t,email,latest.version)).status).toBe(200);
  expect((await f.exchange(old)).status).toBe(200);
  expect((await f.exchange(await f.assertion('after',next))).status).toBe(403);
 },30000);
});

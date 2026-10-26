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

describe('global user-owned login mailbox and independent Access identities',()=>{
 it('declares once, auto-links through Access, and resolves across Applications',async()=>{
  const f=await fixture(),u=await f.user('Global'),t=await f.token(u),email=`owner-${f.suffix}@example.com`;
  expect(await f.settings(t)).toEqual({email:null,version:0,linked:false,status:'unlinked'});
  expect((await f.save(t,email.toUpperCase(),0)).status).toBe(200);
  expect(await f.settings(t)).toEqual({email,version:1,linked:false,status:'pending'});
  expect((await f.db.prepare('SELECT user_id FROM user_login_emails WHERE email=?').bind(email).first<any>()).user_id).toBe(u);
  const a=await f.assertion('first-access',email);
  const r=await f.exchange(a);expect(r.status).toBe(200);
  expect(decodePayload(((await r.json()) as any).data.accessToken).sub).toBe(u);
  expect((await f.db.prepare('SELECT linked_via_email flag FROM access_principals WHERE subject=?')
   .bind('first-access').first<any>()).flag).toBe(1);
  expect(await f.settings(t)).toEqual({email,version:2,linked:true,status:'linked'});
  expect((await f.exchange(await f.assertion('first-access',email,f.other.audience),f.other.secret)).status).toBe(200);
  const second=await f.exchange(await f.assertion('second-access',email,f.other.audience),f.other.secret);
  expect(second.status).toBe(200);
  expect(decodePayload(((await second.json()) as any).data.accessToken).sub).toBe(u);
 },30000);

 it('enforces globally unique mailbox even across Applications and pending vs linked',async()=>{
  const f=await fixture(),u=await f.user('First'),v=await f.user('Second'),
   tu=await f.token(u),tv=await f.token(v,['profile:read','profile:write'],f.other.secret),
   email=`unique-${f.suffix}@example.com`;
  expect((await f.save(tu,email,0)).status).toBe(200);
  const forbidden=await f.save(tv,email,0);
  expect(forbidden.status).toBe(409);
  expect(((await forbidden.json()) as any).error.code).toBe('EMAIL_ALREADY_LINKED');
  expect((await f.exchange(await f.assertion('first',email))).status).toBe(200);
  expect((await f.save(tv,email,0)).status).toBe(409);
  expect(await f.settings(tv)).toEqual({email:null,version:0,linked:false,status:'unlinked'});
  // Concurrent claims cannot bypass the database unique index.
  const otherEmail=`race-${f.suffix}@example.com`;
  const sameTime=await Promise.all([f.save(tu,otherEmail,2),f.save(tv,otherEmail,0)]);
  expect(sameTime.map(r=>r.status).sort()).toEqual([200,409]);
  const owner=await f.db.prepare('SELECT user_id FROM user_login_emails WHERE email=?')
   .bind(otherEmail).first<any>();
  expect([u,v]).toContain(owner.user_id);
 },30000);

 it('replaces the mailbox without disabling usr_* or unrelated code-linked Access principal',async()=>{
  const f=await fixture(),u=await f.user('Multi identity'),t=await f.token(u),
   oldEmail=`old-${f.suffix}@example.com`,nextEmail=`new-${f.suffix}@example.com`,
   independentEmail=`other-${f.suffix}@example.com`;
  const challengeAssertion=await f.assertion('independent-code',independentEmail);
  const challenge=await f.req('/internal/v1/access/link-challenges',{accessAssertion:challengeAssertion},f.home.secret);
  expect(challenge.status).toBe(201);
  const cid=((await challenge.json()) as any).data.challengeId;
  expect((await f.req(`/api/v1/me/access-link-challenges/${cid}/confirm`,{},t)).status).toBe(204);
  expect((await f.exchange(challengeAssertion)).status).toBe(200);
  // Select an independent mailbox; code-linked identity remains usable.
  const first=await f.settings(t);
  expect((await f.save(t,oldEmail,first.version)).status).toBe(200);
  const auto=await f.assertion('email-auto',oldEmail);
  expect((await f.exchange(auto)).status).toBe(200);
  const current=await f.settings(t);
  expect((await f.save(t,nextEmail,current.version)).status).toBe(200);
  expect((await f.exchange(auto)).status).toBe(403);
  expect((await f.req('/internal/v1/access/session-check',{accessAssertion:auto},f.home.secret)).status).toBe(403);
  expect((await f.exchange(challengeAssertion)).status).toBe(200);
  expect((await f.db.prepare("SELECT status FROM users WHERE id=?").bind(u).first<any>()).status).toBe('active');
  const replacement=await f.exchange(await f.assertion('new-access',nextEmail));
  expect(replacement.status).toBe(200);
  expect(decodePayload(((await replacement.json()) as any).data.accessToken).sub).toBe(u);
  const v=await f.user('New owner'),tv=await f.token(v);
  expect((await f.save(tv,oldEmail,0)).status).toBe(200);
 },30000);

 it('unbinds a mailbox without revoking unrelated login identities',async()=>{
  const f=await fixture(),u=await f.user('Unbind'),v=await f.user('Reclaim'),
   t=await f.token(u),tv=await f.token(v),mail=`unbind-${f.suffix}@example.com`;
  expect((await f.save(t,mail,0)).status).toBe(200);
  expect((await f.exchange(await f.assertion('unbind-access',mail))).status).toBe(200);
  const state=await f.settings(t);
  const r=await f.req('/api/v1/me/web-login',{version:state.version},t,'DELETE');
  expect(r.status).toBe(200);
  expect(await f.settings(t)).toEqual({email:null,version:state.version+1,linked:false,status:'unlinked'});
  expect((await f.exchange(await f.assertion('unbind-access',mail))).status).toBe(403);
  expect((await f.save(tv,mail,0)).status).toBe(200);
  expect((await f.req('/api/v1/me/web-login',{version:state.version},t,'DELETE')).status).toBe(409);
 },30000);

 it('challenge-first claims unreserved email, conflicts fail, and cannot claim a second user mailbox',async()=>{
  const f=await fixture(),a=await f.user('A'),b=await f.user('B'),ta=await f.token(a),tb=await f.token(b),
   mail=`challenge-${f.suffix}@example.com`;
  const challenge=await f.req('/internal/v1/access/link-challenges',
   {accessAssertion:await f.assertion('code-link',mail)},f.home.secret);
  const cid=((await challenge.json()) as any).data.challengeId;
  expect((await f.req(`/api/v1/me/access-link-challenges/${cid}/confirm`,{},ta)).status).toBe(204);
  expect(await f.settings(ta)).toEqual({email:mail,version:1,linked:true,status:'linked'});
  expect((await f.save(tb,mail,0)).status).toBe(409);
  const duplicate=await f.req('/internal/v1/access/link-challenges',
   {accessAssertion:await f.assertion('another-code',mail)},f.home.secret);
  const otherId=((await duplicate.json()) as any).data.challengeId;
  const denied=await f.req(`/api/v1/me/access-link-challenges/${otherId}/confirm`,{},tb);
  expect(denied.status).toBe(409);
  expect(((await denied.json()) as any).error.code).toBe('EMAIL_ALREADY_LINKED');
  expect((await f.exchange(await f.assertion('code-link',mail))).status).toBe(200);
  expect((await f.req(`/api/v1/me/access-link-challenges/${cid}/confirm`,{},ta)).status).toBe(409);
 },30000);
});

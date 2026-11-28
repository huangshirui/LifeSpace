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

async function token(privateKey: string, userId: string, scopes: string[]) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: "test-app",
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(path: string, accessToken: string, publicKey: string, init: RequestInit = {}) {
  const db = (env as unknown as TestEnv).DB;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${accessToken}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, { DB: db, IDENTITY_PUBLIC_KEY: publicKey, ENVIRONMENT: "test" });
}

async function createSpace(privateKey: string, publicKey: string, ownerId: string) {
  const accessToken = await token(privateKey, ownerId, ["profile:read", "spaces:read", "spaces:write", "spaces:manage", "grants:manage"]);
  const response = await request("/api/v1/spaces", accessToken, publicKey, {
    method: "POST",
    body: JSON.stringify({ name: "Lifecycle Home", ownerDisplayName: "Owner", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json<{ data: { id: string; version: number } }>();
  return { accessToken, spaceId: payload.data.id, version: payload.data.version };
}

function envelope(n=1) {
  const encode=(size:number)=>btoa(String.fromCharCode(...new Uint8Array(size).fill(n))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
  return {keyVersion:1,kdf:{algorithm:"argon2id",version:19,memoryKiB:65536,iterations:3,parallelism:1,salt:encode(16)},wrappedDek:{algorithm:"A256GCM",nonce:encode(12),ciphertext:encode(48)}};
}

describe("Space encryption Kernel candidate API",()=>{
  it("reads null, initializes, rewraps and rejects stale revision or plaintext password fields",async()=>{
    const {privateKey,publicKey}=await keys();
    const space=await createSpace(privateKey,publicKey,"usr_"+crypto.randomUUID());
    const path="/api/v1/spaces/"+space.spaceId+"/encryption";
    const call=(method:string,body?:unknown)=>request(path,space.accessToken,publicKey,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const empty=await call("GET");
    expect(empty.status).toBe(200);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.json()).toEqual({data:null});
    expect((await call("POST",{...envelope(),password:"synthetic-forbidden"})).status).toBe(422);
    const initialized=await call("POST",envelope());
    expect(initialized.status).toBe(201);
    expect(initialized.headers.get("cache-control")).toBe("no-store");
    expect(await initialized.json()).toEqual({data:{...envelope(),revision:1}});
    expect((await call("POST",envelope(2))).status).toBe(409);
    const updated=await call("PATCH",{expectedRevision:1,envelope:envelope(2)});
    expect(updated.status).toBe(200);
    expect(updated.headers.get("cache-control")).toBe("no-store");
    expect(await updated.json()).toEqual({data:{...envelope(2),revision:2}});
    expect((await call("PATCH",{expectedRevision:1,envelope:envelope(3)})).status).toBe(409);
    expect(await (await call("GET")).json()).toEqual({data:{...envelope(2),revision:2}});
    expect((await call("POST",{oversize:"x".repeat(5000)})).status).toBe(413);
    expect((await request(path,space.accessToken,publicKey,{method:"POST",body:"not json"})).status).toBe(400);
    expect((await call("DELETE")).status).toBe(404);
  });
  it("allows member read but rejects Admin writes, outsider reads and missing scope",async()=>{
    const {privateKey,publicKey}=await keys();
    const space=await createSpace(privateKey,publicKey,"usr_"+crypto.randomUUID());
    const adminId="usr_"+crypto.randomUUID(),outsiderId="usr_"+crypto.randomUUID();
    expect((await request("/api/v1/spaces/"+space.spaceId+"/members",space.accessToken,publicKey,{method:"POST",body:JSON.stringify({userId:adminId,role:"admin",displayName:"Admin"})})).status).toBe(201);
    const admin=await token(privateKey,adminId,["spaces:read","spaces:manage"]);
    const outsider=await token(privateKey,outsiderId,["spaces:read","spaces:manage"]);
    const noScope=await token(privateKey,adminId,["profile:read"]);
    const path="/api/v1/spaces/"+space.spaceId+"/encryption";
    expect((await request(path,space.accessToken,publicKey,{method:"POST",body:JSON.stringify(envelope())})).status).toBe(201);
    expect((await request(path,admin,publicKey)).status).toBe(200);
    expect((await request(path,outsider,publicKey)).status).toBe(403);
    expect((await request(path,noScope,publicKey)).status).toBe(403);
    expect((await request(path,admin,publicKey,{method:"PATCH",body:JSON.stringify({expectedRevision:1,envelope:envelope(2)})})).status).toBe(403);
    expect((await request(path,outsider,publicKey,{method:"POST",body:JSON.stringify(envelope(2))})).status).toBe(403);
    expect(await (await request(path,space.accessToken,publicKey)).json()).toEqual({data:{...envelope(),revision:1}});
  });
});

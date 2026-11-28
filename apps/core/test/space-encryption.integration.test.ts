import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { initializeSpaceEncryption, parseSpaceKeyEnvelope, readSpaceEncryption, rewrapSpaceEncryption, spaceKeyWrapAad, SPACE_KDF_PROFILE } from "../src/space-encryption";

const db = (env as unknown as Bindings).DB;
const bindings = env as unknown as Bindings;
const id = (prefix: string) => prefix+"_"+crypto.randomUUID().replaceAll("-","");
const b64 = (length:number, n:number) => btoa(String.fromCharCode(...new Uint8Array(length).fill(n))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
function envelope(n=1) {
  return {keyVersion:1 as const,kdf:{...SPACE_KDF_PROFILE,salt:b64(16,n)},wrappedDek:{algorithm:"A256GCM" as const,nonce:b64(12,n),ciphertext:b64(48,n)}};
}
function user(): Principal {
  return {type:"user",id:id("usr"),clientId:"app_test_runtime",scopes:["spaces:read","spaces:manage"],tokenId:id("tok")};
}
async function fixture() {
  const owner=user(), admin=user(), member=user(), outsider=user(), space=id("spc"), now=new Date().toISOString();
  await db.prepare("INSERT INTO spaces(id,name,timezone,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(space,"Encryption test","UTC",owner.id,now,now).run();
  for(const [principal,role] of [[owner,"owner"],[admin,"admin"],[member,"viewer"]] as const) {
    await db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(id("mem"),space,principal.id,role,now,now).run();
  }
  return {owner,admin,member,outsider,space};
}

describe("candidate Space encryption persistence",()=>{
  it("accepts only the exact fixed profile and wrapped DEK representation",()=>{
    const input=envelope();
    expect(parseSpaceKeyEnvelope(input)).toEqual(input);
    for(const x of [{...input,password:"never accept"},{...input,keyVersion:2},{...input,kdf:{...input.kdf,memoryKiB:1}},{...input,kdf:{...input.kdf,salt:input.kdf.salt+"="}},{...input,wrappedDek:{...input.wrappedDek,ciphertext:b64(32,1)}},{...input,wrappedDek:{...input.wrappedDek,nonce:"not-base64"}}]) {
      expect(()=>parseSpaceKeyEnvelope(x)).toThrow("Invalid Space encryption key envelope");
    }
    expect(spaceKeyWrapAad("spc_a",input)).not.toEqual(spaceKeyWrapAad("spc_b",input));
    expect(spaceKeyWrapAad("spc_a",input)).not.toEqual(spaceKeyWrapAad("spc_a",envelope(2)));
  });
  it("initializes once, reads for members, rewraps with optimistic revision and audits only metadata",async()=>{
    const {owner,member,space}=await fixture();
    expect(await readSpaceEncryption(bindings,member,space)).toBeNull();
    expect(await initializeSpaceEncryption(bindings,owner,space,envelope())).toEqual({...envelope(),revision:1});
    expect(await readSpaceEncryption(bindings,member,space)).toEqual({...envelope(),revision:1});
    await expect(initializeSpaceEncryption(bindings,owner,space,envelope(2))).rejects.toMatchObject({code:"SPACE_ENCRYPTION_ALREADY_INITIALIZED"});
    expect(await rewrapSpaceEncryption(bindings,owner,space,1,envelope(2))).toEqual({...envelope(2),revision:2});
    await expect(rewrapSpaceEncryption(bindings,owner,space,1,envelope(3))).rejects.toMatchObject({code:"SPACE_ENCRYPTION_REVISION_CONFLICT"});
    await expect(rewrapSpaceEncryption(bindings,owner,space,2,envelope(2))).rejects.toMatchObject({code:"SPACE_ENCRYPTION_REVISION_CONFLICT"});
    expect(await readSpaceEncryption(bindings,owner,space)).toEqual({...envelope(2),revision:2});
    const audit=await db.prepare("SELECT * FROM space_encryption_audit WHERE space_id=? ORDER BY revision").bind(space).all();
    expect(audit.results.map(r=>[r.operation,r.revision,r.actor_user_id])).toEqual([["initialize",1,owner.id],["rewrap",2,owner.id]]);
    expect(Object.keys(audit.results[0]).sort()).toEqual(["actor_user_id","application_id","key_version","occurred_at","operation","revision","space_id"]);
  });
  it("denies outsider, admin writes, service and represented actors; closed Spaces deny access",async()=>{
    const {owner,admin,member,outsider,space}=await fixture();
    await expect(initializeSpaceEncryption(bindings,admin,space,envelope())).rejects.toMatchObject({code:"SPACE_OWNER_REQUIRED"});
    await expect(initializeSpaceEncryption(bindings,member,space,envelope())).rejects.toMatchObject({status:403});
    await expect(initializeSpaceEncryption(bindings,{...owner,actor:{type:"agent",id:id("agt")}},space,envelope())).rejects.toMatchObject({status:403});
    await expect(initializeSpaceEncryption(bindings,{...owner,type:"service"},space,envelope())).rejects.toMatchObject({status:403});
    await expect(initializeSpaceEncryption(bindings,{...owner,scopes:["spaces:read"]},space,envelope())).rejects.toMatchObject({status:403});
    await expect(readSpaceEncryption(bindings,outsider,space)).rejects.toMatchObject({status:403});
    await initializeSpaceEncryption(bindings,owner,space,envelope());
    await expect(rewrapSpaceEncryption(bindings,admin,space,1,envelope(2))).rejects.toMatchObject({status:403});
    await db.prepare("UPDATE spaces SET deleted_at=? WHERE id=?").bind(new Date().toISOString(),space).run();
    await expect(readSpaceEncryption(bindings,member,space)).rejects.toMatchObject({status:403});
    await expect(rewrapSpaceEncryption(bindings,owner,space,1,envelope(2))).rejects.toMatchObject({status:403});
  });
  it("concurrent initialization and wrapping revisions cannot overwrite each other",async()=>{
    const {owner,space}=await fixture();
    const initial=await Promise.allSettled([initializeSpaceEncryption(bindings,owner,space,envelope()),initializeSpaceEncryption(bindings,owner,space,envelope(2))]);
    expect(initial.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    const next=await Promise.allSettled([rewrapSpaceEncryption(bindings,owner,space,1,envelope(3)),rewrapSpaceEncryption(bindings,owner,space,1,envelope(4))]);
    expect(next.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect((await readSpaceEncryption(bindings,owner,space))?.revision).toBe(2);
    expect((await db.prepare("SELECT COUNT(*) AS count FROM space_encryption_audit WHERE space_id=?").bind(space).first<{count:number}>())?.count).toBe(2);
  });
});

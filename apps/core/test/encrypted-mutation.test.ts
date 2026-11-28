import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env";
import type { ModelDefinition } from "../src/model-definition";
import { validateModelDefinition } from "../src/model-definition";
import { candidateCreateId, createSpaceKeyVersionReader, isRecordIdentityConflict, recordIdentityConflict, encryptedCreateRecordId, extractEncryptedCreateIdentity, requireCurrentEncryptedTextKey, validateFieldEncryptionTransition } from "../src/encrypted-mutation";
import { prepareCreateGenericMutation } from "../src/generic-resource";
import type { PublishedModel } from "../src/model-registry";

const wire = "lsenc1.1.AAECAwQFBgcICQoL.AAAAAAAAAAAAAAAAAAAAAA";
const recordId = "rec_123456789abc4def8123456789abcdef";
const otherId = "rec_123456789abc4def9123456789abcdef";
function definition(encrypted = true): ModelDefinition {
  const result = validateModelDefinition({ definitionVersion:1,key:"encrypted_probe",display:{singular:"Probe",plural:"Probes"},fields:{title:{type:"string"},secret:{type:"text",nullable:true,...(encrypted?{encrypted:true}:{})}},access:["read","write"] }, {allowCandidateEncryption:true});
  if (!result.valid) throw new Error(JSON.stringify(result.issues));
  return result.definition;
}
function fakeDb(row: { key_version: number } | null) {
  const first=vi.fn(async()=>row);
  const bind=vi.fn(()=>({first}));
  const prepare=vi.fn(()=>({bind}));
  return { env:{DB:{prepare}} as unknown as Bindings, prepare, bind };
}
describe("encrypted mutation candidate",()=>{
  it("requires stable client create identity only when a non-null encrypted text exists",()=>{
    const d=definition();
    expect(encryptedCreateRecordId(d,{title:"visible"})).toBeUndefined();
    expect(encryptedCreateRecordId(d,{secret:null})).toBeUndefined();
    expect(()=>encryptedCreateRecordId(d,{secret:wire},undefined,otherId)).toThrow("requires a client-generated record id");
    expect(encryptedCreateRecordId(d,{secret:wire},recordId)).toBe(recordId);
    expect(encryptedCreateRecordId(d,{secret:wire},recordId,recordId)).toBe(recordId);
    expect(()=>encryptedCreateRecordId(d,{secret:wire},recordId,otherId)).toThrow("differs");
    expect(()=>extractEncryptedCreateIdentity(d,{id:recordId+"\n"})).toThrow("UUIDv4");
    expect(extractEncryptedCreateIdentity(definition(false),{id:recordId})).toEqual({fields:{id:recordId}});
  });
  it("extracts technical identity without persisting it in model data",()=>{
    const d=definition();
    const model:PublishedModel={id:"mdl_probe",key:d.key,version:1,state:"published",schemaHash:"a".repeat(64),compatibility:"initial",definition:d,publishedAt:"2026-01-01T00:00:00Z"};
    const prepared=prepareCreateGenericMutation(model,{id:recordId,secret:wire,title:"visible"});
    expect(prepared.recordId).toBe(recordId);
    expect(prepared.data).toEqual({secret:wire,title:"visible"});
    expect(()=>prepareCreateGenericMutation({...model,definition:definition(false)},{id:recordId})).toThrow();
  });
  it("skips key lookup for ordinary/empty fields and rejects missing, stale or malformed envelopes",async()=>{
    const absent=fakeDb(null);
    await requireCurrentEncryptedTextKey(absent.env,"spc_probe",definition(),{secret:null});
    await requireCurrentEncryptedTextKey(absent.env,"spc_probe",definition(false),{secret:"ordinary"});
    expect(absent.prepare).not.toHaveBeenCalled();
    await expect(requireCurrentEncryptedTextKey(absent.env,"spc_probe",definition(),{secret:wire})).rejects.toMatchObject({code:"SPACE_ENCRYPTION_NOT_INITIALIZED"});
    const active=fakeDb({key_version:1});
    await requireCurrentEncryptedTextKey(active.env,"spc_probe",definition(),{secret:wire});
    expect(active.bind).toHaveBeenCalledWith("spc_probe");
    await expect(requireCurrentEncryptedTextKey(active.env,"spc_probe",definition(),{secret:wire.replace(".1.",".2.")})).rejects.toMatchObject({code:"SPACE_ENCRYPTION_KEY_VERSION_MISMATCH"});
    await expect(requireCurrentEncryptedTextKey(active.env,"spc_probe",definition(),{secret:"plaintext"})).rejects.toMatchObject({code:"INVALID_RESOURCE"});
  });
  it("allocates only canonical candidate create identity and hides global collision details",()=>{
    expect(candidateCreateId({id:recordId})).toBe(recordId);
    expect(candidateCreateId({secret:wire})).toBeUndefined();
    expect(()=>candidateCreateId({id:"rec_not_uuid"})).toThrow("UUIDv4");
    expect(isRecordIdentityConflict(new Error("D1_ERROR: UNIQUE constraint failed: resource_records.id: SQLITE_CONSTRAINT"))).toBe(true);
    expect(isRecordIdentityConflict(new Error("UNIQUE constraint failed: files.id"))).toBe(false);
    expect(recordIdentityConflict()).toMatchObject({code:"RECORD_ID_CONFLICT",status:409,message:"Record identity is unavailable"});
  });
  it("shares one lazy current-key lookup within a same-Space batch only",async()=>{
    const {env,prepare}=fakeDb({key_version:1});
    const read=createSpaceKeyVersionReader(env,"spc_probe");
    await requireCurrentEncryptedTextKey(env,"spc_probe",definition(),{secret:null},read);
    expect(prepare).not.toHaveBeenCalled();
    await Promise.all([
      requireCurrentEncryptedTextKey(env,"spc_probe",definition(),{secret:wire},read),
      requireCurrentEncryptedTextKey(env,"spc_probe",definition(),{secret:wire},read),
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    await requireCurrentEncryptedTextKey(env,"spc_probe",definition(),{secret:wire},createSpaceKeyVersionReader(env,"spc_probe"));
    expect(prepare).toHaveBeenCalledTimes(2);
  });
  it("rejects published-field encryption switches and encrypted field removal",()=>{
    const plain=definition(false), encrypted=definition();
    expect(validateFieldEncryptionTransition(plain,encrypted)[0]?.code).toBe("FIELD_ENCRYPTION_IMMUTABLE");
    expect(validateFieldEncryptionTransition(encrypted,plain)[0]?.code).toBe("FIELD_ENCRYPTION_IMMUTABLE");
    expect(validateFieldEncryptionTransition(encrypted,{...encrypted,fields:{title:{type:"string"}}})[0]?.code).toBe("FIELD_ENCRYPTION_IMMUTABLE");
    expect(validateFieldEncryptionTransition({...plain,fields:{title:{type:"string"}}},encrypted)).toEqual([]);
    expect(validateFieldEncryptionTransition(encrypted,encrypted)).toEqual([]);
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";
import { compilePhysicalSchema } from "../src/physical-schema";
import { createGenericResource, getGenericResource, updateGenericResource } from "../src/generic-resource";
import { dehydrateTypedResourceData, hydrateTypedResourceData, typedScalarExpression } from "../src/typed-resource-storage";
import { encodeEncryptedText, parseEncryptedText, textFieldAad } from "../src/field-encryption";
import { initializeSpaceEncryption, SPACE_KDF_PROFILE } from "../src/space-encryption";
import { validateHistoricalEncryptionFields } from "../src/encrypted-mutation";

const bindings=env as unknown as Bindings;
const db=bindings.DB;
const randomId=(prefix:string)=>prefix+"_"+crypto.randomUUID().replaceAll("-","");
const b64=(n:number)=>btoa(String.fromCharCode(...new Uint8Array(n).fill(1))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/u,"");
async function fixture(){
  const now=new Date().toISOString(), spaceId=randomId("spc"), modelKey="enc_probe_"+crypto.randomUUID().replaceAll("-","");
  const owner:Principal={type:"user",id:randomId("usr"),clientId:"app_test_runtime",tokenId:randomId("tok"),scopes:["spaces:read","spaces:manage","resources:read","resources:write"]};
  const validated=validateModelDefinition({definitionVersion:1,key:modelKey,display:{singular:"Probe",plural:"Probes"},fields:{title:{type:"string",required:true},secret:{type:"text",encrypted:true,nullable:true,maxLength:100}},query:{searchable:["title"]},access:["read","write"]},{allowCandidateEncryption:true});
  if(!validated.valid)throw new Error(JSON.stringify(validated.issues));
  const definition=validated.definition;
  const model:PublishedModel={id:randomId("mdl"),key:modelKey,version:1,state:"published",definition,schemaHash:"a".repeat(64),compatibility:"initial",publishedAt:now};
  const plan=compilePhysicalSchema(definition);
  // The retired row supplies the actual FK only; no public Registry publication
  // and no baseline model is mutated. Tests pass the candidate descriptor directly.
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,timezone,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(spaceId,"Encrypted storage test","UTC",owner.id,now,now),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(randomId("mem"),spaceId,owner.id,"owner",now,now),
    db.prepare("INSERT INTO model_definitions(id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot,published_at) VALUES(?,?,?,1,'retired',1,?,?,'initial','user',?,?,?)").bind(model.id,modelKey,modelKey,JSON.stringify(definition),model.schemaHash,owner.id,"Tester",now),
    db.prepare(plan.createTableSql),...plan.createIndexSql.map(sql=>db.prepare(sql)),
  ]);
  return {spaceId,owner,model,plan};
}
async function cipher(key:CryptoKey,spaceId:string,modelKey:string,recordId:string,plaintext:string){
  const nonce=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv:nonce,additionalData:textFieldAad(spaceId,modelKey,recordId,"secret",1)},key,new TextEncoder().encode(plaintext)));
  return encodeEncryptedText({keyVersion:1,nonce,ciphertext});
}

describe("candidate encrypted typed D1 storage",()=>{
  it("persists only client ciphertext in typed data and change history, without activating Registry",async()=>{
    const {spaceId,owner,model,plan}=await fixture();
    const recordId=randomId("rec");
    const key=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
    const secret="synthetic sensitive text "+crypto.randomUUID();
    const wire=await cipher(key,spaceId,model.key,recordId,secret);
    const empty=await createGenericResource(bindings,owner,spaceId,model,{title:"empty"});
    expect(empty.data.secret??null).toBeNull();
    await expect(createGenericResource(bindings,owner,spaceId,model,{id:recordId,title:"visible",secret:wire})).rejects.toMatchObject({code:"SPACE_ENCRYPTION_NOT_INITIALIZED"});
    // Synthetic envelope: Core checks its shape, not proof of possession.
    await initializeSpaceEncryption(bindings,owner,spaceId,{keyVersion:1,kdf:{...SPACE_KDF_PROFILE,salt:b64(16)},wrappedDek:{algorithm:"A256GCM",nonce:b64(12),ciphertext:b64(48)}});
    await expect(createGenericResource(bindings,owner,spaceId,model,{id:recordId,title:"visible",secret})).rejects.toMatchObject({code:"INVALID_RESOURCE"});
    await expect(createGenericResource(bindings,owner,spaceId,model,{id:recordId,title:"visible",secret:wire.replace(".1.",".2.")})).rejects.toMatchObject({code:"SPACE_ENCRYPTION_KEY_VERSION_MISMATCH"});
    const created=await createGenericResource(bindings,owner,spaceId,model,{id:recordId,title:"visible",secret:wire});
    expect(created.id).toBe(recordId);
    expect(created.data).toEqual({title:"visible",secret:wire});
    const stored=await db.prepare(`SELECT title,secret FROM "${plan.tableName}" WHERE record_id=?`).bind(recordId).first();
    expect(stored).toEqual({title:"visible",secret:wire});
    expect((await getGenericResource(bindings,spaceId,model,recordId))?.data.secret).toBe(wire);
    const parsed=parseEncryptedText(wire)!;
    const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:parsed.nonce,additionalData:textFieldAad(spaceId,model.key,recordId,"secret",1)},key,parsed.ciphertext);
    expect(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(plain)).toBe(secret);
    const updated=await updateGenericResource(bindings,owner,spaceId,model,recordId,1,{title:"changed"});
    expect(updated.data.secret).toBe(wire);
    const nextWire=await cipher(key,spaceId,model.key,recordId,"next synthetic value");
    expect((await updateGenericResource(bindings,owner,spaceId,model,recordId,2,{secret:nextWire})).data.secret).toBe(nextWire);
    const changes=await db.prepare("SELECT field_changes_json FROM resource_changes WHERE record_id=? ORDER BY version_after").bind(recordId).all<{field_changes_json:string}>();
    const history=JSON.stringify(changes.results);
    expect(history).toContain(wire);
    expect(history).toContain(nextWire);
    expect(history).not.toContain(secret);
    expect(history).not.toContain("next synthetic value");
    await expect(db.prepare(`UPDATE "${plan.tableName}" SET secret=? WHERE record_id=?`).bind(secret,recordId).run()).rejects.toThrow();
    expect(()=>dehydrateTypedResourceData(model,{title:"visible",secret})).toThrow("Invalid encrypted text envelope");
    expect(()=>hydrateTypedResourceData(model,{title:"visible",secret})).toThrow("Stored encrypted text envelope is invalid");
    expect(()=>typedScalarExpression(model,"secret")).toThrow("no server-side scalar query projection");
  });
  it("rejects encryption reuse of historical plaintext field identities",async()=>{
    const {model,owner}=await fixture();
    const old:ModelDefinition={...model.definition,fields:{...model.definition.fields,secret:{type:"text"}}};
    await db.prepare("INSERT INTO model_definitions(id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,published_by_type,published_by_id,published_by_name_snapshot) VALUES(?,?,?,2,'retired',1,?,?,'compatible','user',?,?)").bind(randomId("mdl"),model.key,model.key,JSON.stringify(old),"b".repeat(64),owner.id,"Tester").run();
    const issues=await validateHistoricalEncryptionFields(bindings,model.definition);
    expect(issues).toEqual([{path:"fields.secret.encrypted",code:"FIELD_ENCRYPTION_IMMUTABLE",message:"A historical plaintext field identity cannot be reused as encrypted"}]);
    expect(await validateHistoricalEncryptionFields(bindings,{...old,fields:{title:{type:"string"}}})).toEqual([]);
  });
});

import {test} from "node:test";
import assert from "node:assert/strict";
import {closeCreatedSmokeSpace} from "./staging-smoke-space-lifecycle.mjs";
const id="spc_"+"a".repeat(32);
const input={coreBase:"https://core-staging.aisr.online",identityBase:"https://auth-staging.aisr.online",
 applicationId:"app_staging_smoke_123_2",spaceId:id,createdSpaceId:id,ownerId:"usr_synthetic",userBearer:"synthetic",
 runId:"123",runAttempt:"2"};
function fixture({principal={},space={},detailStatus=200,closeStatus=204}={}){
 const calls=[];
 const request=async(path,init={})=>{
  calls.push({path,init});
  if(path==="/api/v1/me")return Response.json({data:{principal:{type:"user",id:input.ownerId,clientId:input.applicationId,...principal}}});
  if(path.endsWith("/close"))return new Response(null,{status:closeStatus});
  return Response.json({data:{id,name:"LifeSpace staging smoke 123_2",access:"owner",version:7,...space}},{status:detailStatus});
 };
 return {request,calls};
}
test("only exact current run-owned Space receives governed close with current version",async()=>{
 const f=fixture();
 assert.equal(await closeCreatedSmokeSpace(input,f.request),"closed");
 assert.deepEqual(f.calls.map(x=>x.path),["/api/v1/me","/api/v1/spaces/"+id,"/api/v1/spaces/"+id+"/close"]);
 assert.deepEqual(f.calls[2].init,{method:"POST",body:{version:7}});
});
test("historical/unmarked and ambiguous inputs cannot cause mutation",async()=>{
 const f=fixture();
 assert.equal(await closeCreatedSmokeSpace({...input,createdSpaceId:undefined},f.request),"no-creation-marker");
 for(const diff of [{coreBase:"https://core.aisr.online"},{runAttempt:"3"},{applicationId:"app_other"},{spaceId:"spc_"+"b".repeat(32)},{ownerId:""},{runId:""}])
  await assert.rejects(closeCreatedSmokeSpace({...input,...diff},f.request));
 assert.equal(f.calls.length,0);
});
test("denies wrong verified user, mismatched app, Space name, owner or version",async()=>{
 for(const options of [{principal:{id:"usr_other"}},{principal:{clientId:"app_other"}},{space:{name:"Real Space"}},{space:{access:"admin"}},{space:{version:0}}]){
  const f=fixture(options);
  await assert.rejects(closeCreatedSmokeSpace(input,f.request));
  assert.ok(!f.calls.some(x=>x.path.endsWith("/close")));
 }
});
test("already absent is non-mutating, and version conflict never retries close",async()=>{
 const f=fixture({detailStatus:404});
 assert.equal(await closeCreatedSmokeSpace(input,f.request),"already-absent-or-inaccessible");
 assert.equal(f.calls.length,2);
 const conflict=fixture({closeStatus:409});
 await assert.rejects(closeCreatedSmokeSpace(input,conflict.request),/HTTP 204/u);
 assert.equal(conflict.calls.filter(x=>x.path.endsWith("/close")).length,1);
});

test("isolated Eventing fixture requires its exact run name and never closes the shared Space",async()=>{
 const shared="spc_"+"b".repeat(32);
 const eventing={...input,purpose:"eventing",sharedSpaceId:shared};
 const f=fixture({space:{name:"LifeSpace staging smoke 123_2 Eventing"}});
 assert.equal(await closeCreatedSmokeSpace(eventing,f.request),"closed");
 const wrongName=fixture();
 await assert.rejects(closeCreatedSmokeSpace(eventing,wrongName.request),/provenance/u);
 assert.ok(!wrongName.calls.some(x=>x.path.endsWith("/close")));
 const alias=fixture();
 await assert.rejects(closeCreatedSmokeSpace({...eventing,sharedSpaceId:id},alias.request),/differ from shared/u);
 assert.equal(alias.calls.length,0);
});

test("successful close followed by always-run fallback verifies exact audit evidence without a second close",async()=>{
 const eventing={...input,purpose:"eventing",sharedSpaceId:"spc_"+"b".repeat(32)};
 const name="LifeSpace staging smoke 123_2 Eventing", timestamp="2026-11-18T01:22:14.351Z";
 const evidence={id,name,deletedAt:timestamp,closedAt:timestamp,actorUserId:input.ownerId,version:2,closeCount:1,activeMembers:0,activeGrants:0};
 let closed=false,closeCalls=0,reads=0;
 const request=async(path,init={})=>{
   if(path==="/api/v1/me")return Response.json({data:{principal:{type:"user",id:input.ownerId,clientId:input.applicationId}}});
   if(path.endsWith("/close")){assert.equal(closed,false);assert.deepEqual(init.body,{version:1});closed=true;closeCalls++;return new Response(null,{status:204});}
   if(closed)return Response.json({error:{code:"FORBIDDEN"}},{status:403});
   return Response.json({data:{id,name,access:"owner",version:1}});
 };
 assert.equal(await closeCreatedSmokeSpace(eventing,request),"closed");
 assert.equal(await closeCreatedSmokeSpace(eventing,request,{readClosureEvidence:async(target)=>{
   reads++;assert.deepEqual(target,{spaceId:id,expectedName:name,ownerId:input.ownerId});return [evidence];
 }}),"already-closed-verified");
 assert.equal(closeCalls,1);assert.equal(reads,1);
 for(const rows of [[],[evidence,evidence],[{...evidence,id:"spc_"+"c".repeat(32)}],[{...evidence,name:"wrong"}],[{...evidence,actorUserId:"usr_other"}],[{...evidence,deletedAt:null}],[{...evidence,closedAt:"wrong"}],[{...evidence,closeCount:2}],[{...evidence,activeMembers:1}],[{...evidence,activeGrants:1}]]){
   await assert.rejects(closeCreatedSmokeSpace(eventing,request,{readClosureEvidence:async()=>rows}),/audit evidence mismatch/u);
 }
 await assert.rejects(closeCreatedSmokeSpace(eventing,request),/evidence unavailable/u);
 await assert.rejects(closeCreatedSmokeSpace(eventing,request,{readClosureEvidence:async()=>{throw Error("transport failed");}}),/transport failed/u);
 assert.equal(closeCalls,1);
});
test("fallback never consults audit evidence for wrong principal, shared alias, unexpected denial or transient error",async()=>{
 const eventing={...input,purpose:"eventing",sharedSpaceId:"spc_"+"b".repeat(32)};
 let reads=0;const options={readClosureEvidence:async()=>{reads++;return [];}};
 const f=fixture({principal:{id:"usr_other"}});
 await assert.rejects(closeCreatedSmokeSpace(eventing,f.request,options),/credential mismatch/u);
 await assert.rejects(closeCreatedSmokeSpace({...eventing,sharedSpaceId:id},f.request,options),/differ from shared/u);
 for(const [status,code] of [[403,"OTHER"],[500,"INTERNAL_ERROR"],[401,"UNAUTHENTICATED"]]){
   const request=async(path)=>path==="/api/v1/me"
     ?Response.json({data:{principal:{type:"user",id:input.ownerId,clientId:input.applicationId}}})
     :Response.json({error:{code}},{status});
   await assert.rejects(closeCreatedSmokeSpace(eventing,request,options));
 }
 assert.equal(reads,0);
});

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

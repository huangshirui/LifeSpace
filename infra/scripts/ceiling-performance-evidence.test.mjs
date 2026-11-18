import test from "node:test";
import assert from "node:assert/strict";
import {pairCeilingTelemetry,readCeilingTelemetry,preflightCeilingTelemetry} from "./ceiling-performance-evidence.mjs";
const space="spc_"+"a".repeat(32);
const env={LIFESPACE_CORE_STAGING_URL:"https://core-staging.aisr.online",LIFESPACE_IDENTITY_STAGING_URL:"https://auth-staging.aisr.online",
 LIFESPACE_STAGING_SPACE_ID:space,LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID:space,CLOUDFLARE_ACCOUNT_ID:"b".repeat(32),CLOUDFLARE_API_TOKEN:"fake"};
const path="/api/v1/spaces/"+space+"/models/task/records?limit=10";
const requests=Array.from({length:324},(_,i)=>({id:"12345678-1234-1234-1234-"+String(i).padStart(12,"0"),path,mode:i%2?"inherit":"read",scenario:"taskList10",retained:i>=54,elapsedMs:300}));
const rows=()=>requests.map(x=>({message:"LifeSpace performance timing",service:"core",requestId:x.id,method:"GET",status:200,path:path.split("?")[0],totalMs:210,
 phases:{runtime:{access_check:205}},authorityD1:[{success:true,wallMs:200,sqlDurationMs:0.4,statements:1,rowsRead:6}]}));
test("subtract only observed nested D1 wall and add SQL; preserve raw samples",()=>{
 const paired=pairCeilingTelemetry(requests,rows().reverse());
 assert.equal(paired.length,324);assert.equal(paired[0].id,requests[0].id);assert.equal(paired[0].endpointMs,300);
 assert.equal(paired[0].authorityMs,205);assert.equal(paired[0].d1WaitMs,199.6);assert.equal(paired[0].attributableMs,5.4);
});
test("missing, duplicate, wrong route, status, phase or D1 data cannot pass",()=>{
 for(const edit of [r=>r.pop(),r=>r[0]=r[1],r=>r[0].path="/wrong",r=>r[0].status=403,r=>r[0].phases={},r=>r[0].authorityD1=[],
  r=>r[0].authorityD1.push(r[0].authorityD1[0]),r=>r[0].authorityD1[0].sqlDurationMs=null,r=>r[0].authorityD1[0].wallMs=206]){
  const a=rows();edit(a);assert.throws(()=>pairCeilingTelemetry(requests,a));
 }
});
test("telemetry query is dry, exact staging-scoped, bounded and retries ingestion only",async()=>{
 let calls=0,sleeps=0;
 const fetchImpl=async(url,init)=>{
  calls++;assert.ok(url.startsWith("https://api.cloudflare.com/client/v4/accounts/"));assert.equal(init.redirect,"error");
  const b=JSON.parse(init.body);assert.equal(b.dry,true);assert.ok(b.parameters.filters.some(x=>x.value===space));
  const observations=rows().slice(0,calls===1?100:324).map(source=>({source,$metadata:{service:"lifespace-core-staging",message:"LifeSpace performance timing"}}));
  return Response.json({success:true,result:{events:{events:observations}}});
 };
 const now=Date.now();const a=await readCeilingTelemetry(env,{requests,startedAt:now-1000,endedAt:now},fetchImpl,async()=>{sleeps++});
 assert.equal(a.length,324);assert.equal(calls,2);assert.equal(sleeps,1);
 await assert.rejects(preflightCeilingTelemetry({...env,LIFESPACE_STAGING_SPACE_ID:"spc_wrong"},async()=>assert.fail("unsafe query")));
 await assert.rejects(preflightCeilingTelemetry(env,async()=>new Response(null,{status:403})),/HTTP 403/);
 await assert.rejects(readCeilingTelemetry(env,{requests,startedAt:now-1000,endedAt:now},async()=>Response.json({success:true,result:{events:{events:[]}}}),async()=>{}),/Incomplete/);
});

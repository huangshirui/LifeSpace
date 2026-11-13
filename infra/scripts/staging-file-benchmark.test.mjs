import test from "node:test";
import assert from "node:assert/strict";
import {fixture,summarize,observeReadiness,waitForProbeReady} from "./staging-file-benchmark.mjs";
import worker,{handleFileProbe,runFileSample,SIZES} from "../performance-probe/file-worker.mjs";
const space="spc_"+"a".repeat(32),upload="upl_"+"b".repeat(32),file="fil_"+"c".repeat(32);
const env={PROBE_TOKEN:"x".repeat(32),USER_BEARER:"synthetic",SPACE_ID:space,MODEL_KEY:"smoke_file_bench_123_1"};
const root="/api/v1/spaces/"+space,model=root+"/models/"+env.MODEL_KEY+"/records";
const r2="https://"+"d".repeat(32)+".r2.cloudflarestorage.com/lifespace-staging-assets/";
const signed=key=>r2+key+"?X-Amz-Signature=synthetic";
function mock({wrongBytes=false,wrongBucket=false,finalizeFail=false}={}){
 let bytes,name;const calls=[];
 const fetcher=async(url,init={})=>{
  const p=new URL(url).pathname,m=init.method??"GET";calls.push([m,p]);
  const json=(data,status=200)=>Response.json({data},{status,headers:{"x-request-id":init.headers?.["x-request-id"]??""}});
  if(p===root+"/file-uploads"){
   name=JSON.parse(init.body).name;
   return json({id:upload,upload:{method:"PUT",headers:{"content-type":"application/octet-stream"},
     url:wrongBucket?signed("uploads/native/"+space+"/"+upload).replace("lifespace-staging-assets","production"):signed("uploads/native/"+space+"/"+upload)}},201);
  }
  if(m==="PUT"){bytes=init.body;return new Response(null,{status:200});}
  if(p.endsWith("/complete"))return finalizeFail?json({},502):json({id:file,size:SIZES[0],name,contentType:"application/octet-stream"});
  if(p===model&&m==="POST")return json({id:"rec_synthetic",version:1,attachments:[file]},201);
  if(p===root+"/file-downloads")return json({id:file,size:SIZES[0],contentType:"application/octet-stream",url:signed("files/"+space+"/"+file)});
  if(m==="GET"&&p.includes("/files/"))return new Response(wrongBytes?new Uint8Array(bytes.length):bytes,{headers:{"content-type":"application/octet-stream"}});
  if(m==="DELETE")return new Response(null,{status:204});
  throw Error("unexpected");
 };return {fetcher,calls};
}
test("exact run fixture and nearest-rank summaries",()=>{
 const e={GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",LIFESPACE_CORE_STAGING_URL:"https://core-staging.aisr.online",
 LIFESPACE_IDENTITY_STAGING_URL:"https://auth-staging.aisr.online",LIFESPACE_STAGING_SMOKE_APPLICATION_ID:"app_staging_smoke_123_1",
 LIFESPACE_STAGING_SPACE_ID:space,LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID:space,LIFESPACE_STAGING_SMOKE_USER_ID:"usr_test"};
 assert.equal(fixture(e).key,env.MODEL_KEY);assert.throws(()=>fixture({...e,LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID:"spc_other"}));
 assert.throws(()=>fixture({...e,LIFESPACE_CORE_STAGING_URL:"https://core.aisr.online"}));
 assert.deepEqual(summarize(Array.from({length:15},(_,i)=>15-i)),{samples:15,p50Ms:8,p90Ms:14,maxMs:15});
 assert.throws(()=>summarize([1,NaN]));
});
test("sample measures full lifecycle and deletes record then file",async()=>{
 const f=mock(),result=await runFileSample(env,SIZES[0],f.fetcher);
 assert.equal(result.ok,true);assert.ok(result.completeRequestId);assert.ok(Number.isFinite(result.timings.saveE2eMs));
 assert.deepEqual(f.calls.slice(-2),[["DELETE",model+"/rec_synthetic"],["DELETE",root+"/files/"+file]]);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-|Signature|fil_|upl_/);
});
test("integrity failure cleans up; wrong bucket denies PUT; ambiguous finalize never retried",async()=>{
 for(const [options,stage] of [[{wrongBytes:true},"download"],[{wrongBucket:true},"session"],[{finalizeFail:true},"finalize"]]){
  const f=mock(options),result=await runFileSample(env,SIZES[0],f.fetcher);
  assert.equal(result.ok,false);assert.equal(result.stage,stage);
  if(options.wrongBytes)assert.equal(f.calls.filter(x=>x[0]==="DELETE").length,2);
  if(options.wrongBucket)assert.equal(f.calls.filter(x=>x[0]==="PUT").length,0);
  if(options.finalizeFail)assert.equal(f.calls.filter(x=>x[1].endsWith("/complete")).length,1);
 }
});
test("probe refuses wrong token and arbitrary size without forwarding",async()=>{
 const req=(token,size)=>new Request("https://probe.example/sample",{method:"POST",headers:{"x-lifespace-probe-token":token},body:JSON.stringify({size})});
 const f=async()=>{throw Error("no forwarding");};
 assert.equal((await handleFileProbe(req("wrong",SIZES[0]),env,f)).status,404);
 assert.equal((await handleFileProbe(req(env.PROBE_TOKEN,1),env,f)).status,400);
});

test("Worker entrypoint ignores execution context as a fetch implementation",async()=>{
 const response=await worker.fetch(new Request("https://probe.example/sample",{method:"POST",
 headers:{"x-lifespace-probe-token":"wrong"},body:"{}"}),env,{waitUntil(){}});
 assert.equal(response.status,404);
});

const probeRequest=(phase,token=env.PROBE_TOKEN)=>new Request("https://probe.example/"+phase,{headers:{"x-lifespace-probe-token":token}});
test("liveness is local, fixture readiness is authenticated and read-only",async()=>{
 const noFetch=async()=>{assert.fail("unexpected Core request");};
 assert.equal((await handleFileProbe(probeRequest("health","wrong"),env,noFetch)).status,404);
 const missing=await handleFileProbe(probeRequest("health"),{...env,USER_BEARER:""},noFetch);
 assert.equal(missing.status,503);assert.equal((await missing.json()).stage,"configuration");
 const health=await handleFileProbe(probeRequest("health"),env,noFetch);
 assert.deepEqual(await health.json(),{probe:"native-file-v1",stage:"probe",ok:true});
 let called=0;
 const ready=await handleFileProbe(probeRequest("ready"),env,async(url,init)=>{
  called++;assert.equal(url,"https://core-staging.aisr.online"+root+"/_discovery/models/"+env.MODEL_KEY);
  assert.equal(init.method??"GET","GET");assert.equal(init.headers.authorization,"Bearer synthetic");
  assert.equal(init.redirect,"error");
  return Response.json({data:{fields:[{key:"attachments",type:"file_list"}]}},{headers:{"x-request-id":init.headers["x-request-id"]}});
 });
 assert.equal(called,1);assert.equal(ready.status,200);const body=await ready.json();
 assert.equal(body.stage,"core");assert.equal(body.ok,true);assert.equal(body.correlationMatched,true);
});
test("readiness exposes safe failure categories without leaking upstream response or exceptions",async()=>{
 for(const [fetcher,stage,status] of [
  [async()=>{throw Error("sensitive URL or credential");},"core_transport",undefined],
  [async()=>new Response("sensitive upstream body",{status:403}),"core_http",403],
  [async()=>new Response("sensitive upstream body"),"core_json",200],
  [async()=>Response.json({data:{fields:[{key:"sensitive",type:"string"}]}}),"core_schema",200],
 ]){
  const res=await handleFileProbe(probeRequest("ready"),env,fetcher);assert.equal(res.status,503);
  const body=await res.json();assert.equal(body.stage,stage);assert.equal(body.coreStatus,status);assert.equal(body.ok,false);
  assert.doesNotMatch(JSON.stringify(body),/sensitive|synthetic|Bearer|https:/);
 }
});
test("runner distinguishes workers.dev response, wrong token, transport and Core failure without raw body",async()=>{
 const observe=fetchImpl=>observeReadiness("https://probe.example",{},"health",{fetchImpl});
 assert.deepEqual(await observe(async()=>new Response("<html>secret</html>",{status:404})),{phase:"health",ok:false,status:404,reason:"non_json"});
 assert.deepEqual(await observe(async()=>Response.json({error:"not_found"},{status:404})),{phase:"health",ok:false,status:404,reason:"unexpected_response"});
 assert.deepEqual(await observe(async()=>{throw Error("secret");}),{phase:"health",ok:false,reason:"transport"});
 const core=await observeReadiness("https://probe.example",{},"ready",{fetchImpl:async()=>Response.json({probe:"native-file-v1",stage:"core_http",ok:false,coreStatus:403,requestId:"secret",reason:"secret",body:"secret"},{status:503})});
 assert.deepEqual(core,{phase:"ready",ok:false,status:503,stage:"core_http",coreStatus:403});
});
test("both readiness stages must converge within fixture budget before sampling",async()=>{
 const paths=[],observations=[];let clock=0,tries=0;
 await waitForProbeReady("https://probe.example",{},300000,{now:()=>clock,sleep:async ms=>{clock+=ms;},log:e=>observations.push(e),fetchImpl:async url=>{
  const phase=new URL(url).pathname;paths.push(phase);tries++;
  if(tries===1)return new Response("route pending",{status:404});
  return Response.json({probe:"native-file-v1",stage:phase==="/health"?"probe":"core",ok:true});
 }});
 assert.deepEqual(paths,["/health","/health","/ready"]);assert.equal(observations.length,3);
 await assert.rejects(waitForProbeReady("https://probe.example",{},120000,{now:()=>0,fetchImpl:async()=>assert.fail("budget exhausted")}),/insufficient readiness budget/);
 await assert.rejects(waitForProbeReady("https://probe.example",{},300000,{now:()=>clock,sleep:async ms=>{clock+=ms;},log:()=>{},fetchImpl:async url=>Response.json({probe:"native-file-v1",stage:new URL(url).pathname==="/health"?"probe":"core_http",ok:new URL(url).pathname==="/health",coreStatus:403})}),/core_http/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {fixture,summarize} from "./staging-file-benchmark.mjs";
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

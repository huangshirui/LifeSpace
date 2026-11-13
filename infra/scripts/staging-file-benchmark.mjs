import {appendFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {executeStagingD1Sql} from "./staging-d1-retry.mjs";
import {SIZES} from "../performance-probe/file-worker.mjs";
const CORE="https://core-staging.aisr.online", IDENTITY="https://auth-staging.aisr.online", COUNT=15;
const check=(ok,reason)=>{if(!ok)throw Error(reason);};
const q=v=>"'"+String(v).replaceAll("'","''")+"'";
const sql=async command=>(await executeStagingD1Sql({cwd:new URL("../../apps/core/",import.meta.url),sql:command})).flatMap(x=>x.results??[]);
export function fixture(e){
 const suffix=e.GITHUB_RUN_ID+"_"+e.GITHUB_RUN_ATTEMPT,space=e.LIFESPACE_STAGING_SPACE_ID;
 check(e.LIFESPACE_CORE_STAGING_URL===CORE&&e.LIFESPACE_IDENTITY_STAGING_URL===IDENTITY
  &&/^[0-9]+_[1-9][0-9]*$/u.test(suffix)&&e.LIFESPACE_STAGING_SMOKE_APPLICATION_ID==="app_staging_smoke_"+suffix
  &&/^spc_[a-f0-9]{32}$/u.test(space??"")&&space===e.LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID
  &&/^usr_[A-Za-z0-9_-]+$/u.test(e.LIFESPACE_STAGING_SMOKE_USER_ID??""),"run fixture provenance mismatch");
 return {suffix,space,app:e.LIFESPACE_STAGING_SMOKE_APPLICATION_ID,user:e.LIFESPACE_STAGING_SMOKE_USER_ID,key:"smoke_file_bench_"+suffix};
}
export function summarize(values){
 check(values.length>0&&values.every(x=>Number.isFinite(x)&&x>=0),"invalid measurement");
 const s=[...values].sort((a,b)=>a-b);
 return {samples:s.length,p50Ms:s[Math.ceil(.5*s.length)-1],p90Ms:s[Math.ceil(.9*s.length)-1],maxMs:s.at(-1)};
}
async function request(url,bearer,method="GET",body,status=200){
 const res=await fetch(url,{method,redirect:"error",signal:AbortSignal.timeout(60000),
  headers:{authorization:"Bearer "+bearer,...(body===undefined?{}:{"content-type":"application/json"})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 check(res.status===status,"fixture request failed HTTP "+res.status);
 return status===204?null:(await res.json()).data;
}
async function owner(e,f){
 const data=await request(IDENTITY+"/internal/v1/tokens",e.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET,"POST",
  {subjectId:f.user,scopes:["profile:read","spaces:read","spaces:manage","grants:manage","resources:read","resources:write"]});
 const bearer=data?.accessToken;
 check(typeof bearer==="string"&&bearer.length>0&&!/[\r\n]/u.test(bearer),"fresh owner token unavailable");
 console.log("::add-mask::"+bearer);
 const me=await request(CORE+"/api/v1/me",bearer),space=await request(CORE+"/api/v1/spaces/"+f.space,bearer);
 check(me?.principal?.type==="user"&&me.principal.id===f.user&&me.principal.clientId===f.app
  &&space?.id===f.space&&space.name==="LifeSpace staging smoke "+f.suffix&&space.access==="owner","fixture owner mismatch");
 appendFileSync(e.GITHUB_ENV,"LIFESPACE_STAGING_USER_BEARER="+bearer+"\n");
 return bearer;
}
async function prepare(e,f){
 const bearer=await owner(e,f);
 check(/^svc_[A-Za-z0-9_-]+$/u.test(e.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID??""),"invalid fixture service");
 appendFileSync(e.GITHUB_ENV,"LIFESPACE_FILE_BENCH_MODEL="+f.key+"\n");
 await request(CORE+"/api/v1/model-admin/models",e.LIFESPACE_STAGING_MODEL_ADMIN_BEARER,"POST",{
  compatibility:"initial",definition:{definitionVersion:1,key:f.key,display:{singular:"Synthetic file benchmark",plural:"Synthetic file benchmarks"},
  access:["read","write"],fields:{name:{type:"string",required:true},attachments:{type:"file_list",nullable:true}}}},201);
 const now=new Date().toISOString();
 await sql("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at) VALUES("
  +[f.app,f.key,"write","service",e.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID,now,now].map(q).join(",")+")");
 await new Promise(r=>setTimeout(r,65000));
 const detail=await request(CORE+"/api/v1/spaces/"+f.space+"/_discovery/models/"+f.key,bearer);
 check(detail?.fields?.some(x=>x.key==="attachments"&&x.type==="file_list"),"fixture model unavailable");
}
const readinessStages=new Set(["configuration","probe","core","core_transport","core_http","core_json","core_schema"]);
const validStatus=n=>Number.isInteger(n)&&n>=100&&n<=599;
export async function observeReadiness(origin,headers,phase,{fetchImpl=fetch,timeoutMs=12000}={}){
 check(phase==="health"||phase==="ready","invalid readiness phase");
 let response;
 try{response=await fetchImpl(origin+"/"+phase,{headers,redirect:"error",signal:AbortSignal.timeout(timeoutMs)});}
 catch(error){return {phase,ok:false,reason:error?.name==="TimeoutError"||error?.name==="AbortError"?"timeout":"transport"};}
 const status=response.status;
 let data;
 try{data=await response.json();}
 catch{return {phase,ok:false,status,reason:"non_json"};}
 if(data?.probe!=="native-file-v1"||!readinessStages.has(data.stage))
  return {phase,ok:false,status,reason:"unexpected_response"};
 const ok=response.ok&&data.ok===true&&data.stage===(phase==="health"?"probe":"core");
 return {phase,ok,status,stage:data.stage,
  ...(validStatus(data.coreStatus)?{coreStatus:data.coreStatus}:{}),
  ...(typeof data.correlationMatched==="boolean"?{correlationMatched:data.correlationMatched}:{}),
  ...(typeof data.requestId==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(data.requestId)?{requestId:data.requestId}:{}),
  ...(data.reason==="timeout"||data.reason==="fetch_failed"?{reason:data.reason}:{})};
}
export async function waitForProbeReady(origin,headers,fixtureDeadline,{fetchImpl=fetch,now=Date.now,
 sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=entry=>console.log(JSON.stringify({FILE_PROBE_READINESS:entry}))}={}){
 const deadline=Math.min(now()+90000,fixtureDeadline-120000);
 check(Number.isFinite(deadline)&&deadline>now(),"insufficient readiness budget");
 let phase="health",last={phase,ok:false,reason:"not_attempted"};
 for(let attempt=1;attempt<=30&&now()<deadline;attempt++){
  last=await observeReadiness(origin,headers,phase,{fetchImpl,timeoutMs:Math.max(1,Math.min(12000,deadline-now()))});
  log({attempt,...last});
  if(last.ok&&phase==="ready")return;
  if(last.ok){phase="ready";continue;}
  if(attempt<30&&now()<deadline)await sleep(Math.min(2000,deadline-now()));
 }
 throw Error("probe did not converge: "+JSON.stringify(last));
}
async function measure(e,f){
 check(e.LIFESPACE_FILE_BENCH_MODEL===f.key,"missing run-owned model");
 const u=new URL(e.LIFESPACE_APAC_PROBE_URL);
 check(u.protocol==="https:"&&!u.username&&!u.password&&!u.port&&!u.search&&!u.hash&&u.pathname==="/"
  &&u.hostname.startsWith("lifespace-staging-file-benchmark-probe-"+e.GITHUB_RUN_ID+".")&&u.hostname.endsWith(".workers.dev"),"invalid probe URL");
 const headers={"x-lifespace-probe-token":e.LIFESPACE_APAC_PROBE_TOKEN,"content-type":"application/json"};
 await waitForProbeReady(u.origin,headers,Date.parse(e.LIFESPACE_FILE_BENCH_DEADLINE??""));
 const start=Date.now(),batches=[];
 // The original 15-minute service fixture must remain usable for retirement.
 // The freshly minted owner token alone cannot extend that service deadline.
 const deadline=Math.min(start+9*60000,Date.parse(e.LIFESPACE_FILE_BENCH_DEADLINE??""));
 check(Number.isFinite(deadline)&&deadline>start,"missing or expired fixture budget");
 for(const size of SIZES){
  const rows=[];
  for(let i=0;i<COUNT;i++){
   check(Date.now()+120000<deadline,"benchmark exceeded safe fixture budget");
   const tick=performance.now();
   const response=await fetch(u.origin+"/sample",{method:"POST",headers,body:JSON.stringify({size}),
    redirect:"error",signal:AbortSignal.timeout(120000)});
   const row=await response.json().catch(()=>null);
   check(response.ok&&row?.ok===true&&row.size===size&&row.cleanupOk===true,
    "file sample failed: size="+size+" index="+(i+1)+" stage="+(row?.stage??"transport_or_cleanup"));
   check(typeof row.completeRequestId==="string"&&/^[a-f0-9-]{36}$/u.test(row.completeRequestId),"missing finalize correlation");
   rows.push({...row.timings,totalWithCleanupMs:row.totalWithCleanupMs,
    runnerToProbeWithCleanupMs:Math.round((performance.now()-tick)*10)/10,completeRequestId:row.completeRequestId});
  }
  const keys=["sessionMs","putMs","finalizeHeadersMs","finalizeMs","attachMs","uploadE2eMs","saveE2eMs","downloadSessionMs","downloadMs","totalWithCleanupMs","runnerToProbeWithCleanupMs"];
  const batch={sizeBytes:size,metrics:Object.fromEntries(keys.map(k=>[k,summarize(rows.map(x=>x[k]))])),samples:rows};
  batches.push(batch);console.log(JSON.stringify({FILE_BENCHMARK_BATCH:batch}));
 }
 console.log(JSON.stringify({FILE_BENCHMARK:{ok:true,diagnosticOnly:true,source:"APAC probe -> Core and signed R2",
  candidate:e.GITHUB_SHA,samplesPerSize:COUNT,batches}}));
}
async function cleanup(e,f){
 if(e.LIFESPACE_FILE_BENCH_MODEL!==f.key)return;
 const bearer=await owner(e,f),root=CORE+"/api/v1/spaces/"+f.space;
 const condition="space_id="+q(f.space)+" AND model_key="+q(f.key);
 check(e.LIFESPACE_FILE_BENCH_MODEL===f.key,"cleanup model provenance mismatch");
 // Never re-execute an ambiguous write. Recover only current-run model/Space
 // records and completed Native files through the canonical delete APIs.
 const records=await sql("SELECT id,version FROM resource_records WHERE "+condition+" AND deleted_at IS NULL");
 let failed=false;
 for(const rec of records){
  try{check(/^rec_[A-Za-z0-9_-]+$/u.test(rec.id)&&Number.isSafeInteger(rec.version),"invalid record");
   await request(root+"/models/"+f.key+"/records/"+rec.id,bearer,"DELETE",{version:rec.version},204);}
  catch{failed=true;}
 }
 const files=await sql("SELECT f.id FROM files f JOIN file_upload_sessions u ON u.file_id=f.id AND u.space_id=f.space_id WHERE u.space_id="+q(f.space)
  +" AND u.model_key="+q(f.key)+" AND u.application_id="+q(f.app)+" AND u.status='completed' AND f.status IN ('ready','deleting')");
 for(const row of files){
  try{check(/^fil_[a-f0-9]{32}$/u.test(row.id),"invalid file");await request(root+"/files/"+row.id,bearer,"DELETE",undefined,204);}
  catch{failed=true;}
 }
 const sessions=await sql("SELECT status,cleaned_at FROM file_upload_sessions WHERE "+condition+" AND application_id="+q(f.app));
 const pending=sessions.filter(x=>!x.cleaned_at).length;
 // Do not retire a model if its known file/record recovery failed. The
 // outer smoke cleanup still revokes the fixture credentials and closes its
 // Space. Such failure is reported rather than silently claimed clean.
 if(!failed){
  try{await request(CORE+"/api/v1/model-admin/models/"+f.key+"/retire",e.LIFESPACE_STAGING_MODEL_ADMIN_BEARER,"POST",{},204);}
  catch{failed=true;}
 }
 await sql("DELETE FROM application_model_access WHERE application_id="+q(f.app)+" AND model_key="+q(f.key));
 console.log(JSON.stringify({FILE_BENCHMARK_CLEANUP:{ok:!failed,recoveredRecords:records.length,recoveredFiles:files.length,
  sessions:sessions.length,stageCleanupPending:pending,scheduledFallback:pending>0}}));
 check(!failed,"file fixture cleanup incomplete");
}
async function main(){
 const e=process.env,mode=process.argv[2];
 if(mode==="cleanup"&&!e.LIFESPACE_FILE_BENCH_MODEL)return;
 const f=fixture(e);
 if(mode==="prepare")await prepare(e,f);
 else if(mode==="measure")await measure(e,f);
 else if(mode==="cleanup")await cleanup(e,f);
 else throw Error("expected prepare, measure, or cleanup");
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();

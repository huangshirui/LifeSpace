// Read existing Staging-only Core telemetry; no D1 queries or runtime headers.
// All 324 observations (including 54 warmups) must have unique evidence.
const message = "LifeSpace performance timing";
const service = "lifespace-core-staging";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const finite = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
function assert(condition, text) { if (!condition) throw new Error(text); }
function scope(env) {
  const space=env.LIFESPACE_STAGING_SPACE_ID, account=env.CLOUDFLARE_ACCOUNT_ID;
  const token=env.LIFESPACE_APAC_OBSERVABILITY_TOKEN || env.CLOUDFLARE_API_TOKEN;
  assert(env.LIFESPACE_CORE_STAGING_URL==="https://core-staging.aisr.online"
    && env.LIFESPACE_IDENTITY_STAGING_URL==="https://auth-staging.aisr.online"
    && /^spc_[a-f0-9]{32}$/u.test(space??"") && space===env.LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID
    && /^[a-f0-9]{32}$/iu.test(account??"") && typeof token==="string" && token.length>0,
    "Staging Ceiling telemetry requires exact fixture and Cloudflare credentials");
  return {space,account,token};
}
async function query(env, from, to, fetchImpl, limit=1000) {
  const {space,account,token}=scope(env);
  const response=await fetchImpl("https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/observability/telemetry/query",{
    method:"POST",redirect:"error",signal:AbortSignal.timeout(15000),
    headers:{authorization:"Bearer "+token,"content-type":"application/json"},
    body:JSON.stringify({queryId:"lifespace-staging-ceiling-evidence",dry:true,view:"events",limit,
      timeframe:{from,to},parameters:{filters:[
        {key:"$metadata.service",operation:"eq",type:"string",value:service},
        {key:"$metadata.message",operation:"eq",type:"string",value:message},
        {key:"path",operation:"includes",type:"string",value:space}
      ]}})
  });
  if (!response.ok) throw Error("Ceiling telemetry query HTTP "+response.status+"; verify Workers Observability permission");
  const json=await response.json().catch(()=>null);
  assert(json?.success===true && Array.isArray(json.result?.events?.events),"Invalid Ceiling telemetry response");
  return json.result.events.events;
}
export async function preflightCeilingTelemetry(env, fetchImpl=fetch) {
  const now=Date.now();
  await query(env,now-60000,now,fetchImpl,1);
}
export async function readCeilingTelemetry(env,{requests,startedAt,endedAt},fetchImpl=fetch,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))) {
  assert(Array.isArray(requests)&&requests.length===324
    && requests.every(x=>uuid.test(x.id??"")) && new Set(requests.map(x=>x.id)).size===324,
    "Missing or duplicate Ceiling probe correlation IDs");
  assert(Number.isSafeInteger(startedAt)&&Number.isSafeInteger(endedAt)&&endedAt>=startedAt,
    "Invalid Ceiling telemetry timeframe");
  const wanted=new Set(requests.map(x=>x.id));
  // Retry only missing observations (log ingestion); never replace measured requests.
  for(let attempt=0;attempt<7;attempt++){
    const events=await query(env,startedAt-30000,Math.min(Date.now(),endedAt+30000),fetchImpl);
    const matched=new Map();
    for(const event of events){
      const row=event?.source;
      if(!wanted.has(row?.requestId))continue;
      assert(event?.$metadata?.service===service && event?.$metadata?.message===message
        && row.message===message && row.service==="core","Unexpected Ceiling telemetry provenance");
      assert(!matched.has(row.requestId),"Duplicate Ceiling telemetry observation");
      matched.set(row.requestId,row);
    }
    if(matched.size===wanted.size)return requests.map(x=>matched.get(x.id));
    if(attempt<6)await sleep(10000);
  }
  throw Error("Incomplete Ceiling telemetry after bounded ingestion wait; release blocked");
}
// The only nested authority D1 call is observed inside access_check/discovery_state.
// Substitute actual SQL execution for the binding's wall time, retaining all
// other measured phase work. This is attributable elapsed cost, not CPU time.
export function pairCeilingTelemetry(requests,rows) {
  assert(Array.isArray(requests)&&requests.length===324&&new Set(requests.map(x=>x.id)).size===324
    && requests.every(x=>uuid.test(x.id??"")),"Invalid Ceiling request evidence");
  assert(Array.isArray(rows)&&rows.length===requests.length,"Incomplete Ceiling telemetry");
  const byId=new Map();
  for(const row of rows){
    assert(row && uuid.test(row.requestId??"") && !byId.has(row.requestId),"Duplicate or invalid Ceiling telemetry ID");
    byId.set(row.requestId,row);
  }
  return requests.map(sample=>{
    const row=byId.get(sample.id);
    assert(row?.message===message && row.service==="core" && row.method==="GET" && row.status===200
      && row.path===sample.path.split("?")[0] && finite(row.totalMs)
      && ["taskGet","taskList10","discovery"].includes(sample.scenario)
      && ["inherit","read"].includes(sample.mode),"Mismatched Ceiling telemetry");
    const phase=row.phases?.runtime?.[sample.scenario==="discovery"?"discovery_state":"access_check"];
    const batches=row.authorityD1;
    assert(finite(phase)&&phase<=row.totalMs+0.2 && Array.isArray(batches)&&batches.length===1,
      "Missing or unexpected Ceiling authority phase or D1 batch");
    const b=batches[0];
    assert(b?.success===true && finite(b.wallMs)&&finite(b.sqlDurationMs)
      && Number.isSafeInteger(b.statements)&&b.statements>0
      && Number.isSafeInteger(b.rowsRead)&&b.rowsRead>=0
      && b.wallMs<=phase+0.2,"Invalid Ceiling authority D1 evidence");
    return {id:sample.id,mode:sample.mode,scenario:sample.scenario,retained:sample.retained,
      endpointMs:sample.elapsedMs,coreMs:row.totalMs,authorityMs:phase,
      d1WallMs:b.wallMs,d1SqlMs:b.sqlDurationMs,
      d1WaitMs:Math.max(0,b.wallMs-b.sqlDurationMs),
      attributableMs:Number((Math.max(0,phase-b.wallMs)+b.sqlDurationMs).toFixed(1)),
      batches:batches.length,statements:b.statements,rowsRead:b.rowsRead};
  });
}

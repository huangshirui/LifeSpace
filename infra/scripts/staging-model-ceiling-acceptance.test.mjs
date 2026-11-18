import test from "node:test";
import assert from "node:assert/strict";
import { ceilingFixture, compareCeilingSamples, runCeilingApacAcceptance } from "./staging-model-ceiling-acceptance.mjs";

test("comparison includes all 45 samples and detects median or tail regression",()=>{
  const baseline=Array(45).fill(100);
  assert.equal(compareCeilingSamples(baseline,Array(45).fill(105)).relativeMet,true);
  assert.equal(compareCeilingSamples(baseline,Array(45).fill(106)).relativeMet,false);
  assert.equal(compareCeilingSamples(baseline,[...Array(40).fill(100),...Array(5).fill(120)]).relativeMet,false);
  assert.equal(compareCeilingSamples(Array(45).fill(200),Array(45).fill(210)).relativeMet,true);
  assert.throws(()=>compareCeilingSamples(baseline,baseline.slice(1)),/Incomplete/);
  assert.throws(()=>compareCeilingSamples(baseline,[...baseline.slice(1),NaN]),/invalid/);
});
const space="spc_"+"a".repeat(32), app="app_staging_smoke_123_1";
const env={GITHUB_RUN_ID:"123",GITHUB_RUN_ATTEMPT:"1",LIFESPACE_CORE_STAGING_URL:"https://core-staging.aisr.online",
  LIFESPACE_IDENTITY_STAGING_URL:"https://auth-staging.aisr.online",LIFESPACE_STAGING_SPACE_ID:space,
  LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID:space,LIFESPACE_STAGING_SMOKE_APPLICATION_ID:app,
  LIFESPACE_STAGING_SMOKE_USER_ID:"usr_owner",LIFESPACE_STAGING_SMOKE_CLAIMANT_USER_ID:"usr_member",
  LIFESPACE_STAGING_USER_BEARER:"owner",LIFESPACE_STAGING_CLAIMANT_USER_BEARER:"member",
  LIFESPACE_STAGING_SERVICE_BEARER:"service",LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET:"secret"};
test("fixture refuses non-staging or non-run-owned target before HTTP",async()=>{
  const forbidden=async()=>{assert.fail("unsafe fixture performed HTTP")};
  await assert.rejects(ceilingFixture({...env,LIFESPACE_CORE_STAGING_URL:"https://core.aisr.online"},forbidden));
  await assert.rejects(ceilingFixture({...env,LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID:"spc_other"},forbidden));
  await assert.rejects(ceilingFixture({...env,LIFESPACE_STAGING_SMOKE_APPLICATION_ID:"app_real"},forbidden));
});
function fakeFixture(latency=40){
  let ceiling=null,seq=0;const rows=new Map(),phases=[],calls=[];
  const base="/api/v1/spaces/"+space,records=base+"/models/task/records",config=base+"/members/usr_member/model-access";
  const json=(data,status=200)=>Response.json({data},{status});
  const model=(key)=>({modelKey:key,ceiling:key==="task"?ceiling:null,baseAccess:["read","write"],boundedAccess:key==="task"&&ceiling==="read"?["read"]:["read","write"]});
  const fetchImpl=async(url,init)=>{
    const path=new URL(url).pathname,bearer=init.headers.authorization;
    assert.equal(new URL(url).origin,env.LIFESPACE_CORE_STAGING_URL);
    if(path==="/api/v1/me")return json({principal:{type:"user",id:bearer==="Bearer owner"?"usr_owner":"usr_member",clientId:app}});
    if(path===base)return json({id:space,name:"LifeSpace staging smoke 123_1",access:bearer==="Bearer owner"?"owner":"editor"});
    assert.equal(bearer,"Bearer owner");
    if(path===config&&init.method==="GET")return json({role:"editor",models:[model("task"),model("event")]});
    if(path===config+"/task"){
      ceiling=init.method==="DELETE"?null:JSON.parse(init.body).maxAccess;phases.push(ceiling);
      return new Response(null,{status:204});
    }
    if(path===records&&init.method==="POST"){
      const row={id:"rec_"+(++seq),version:1};rows.set(row.id,row);return json(row,201);
    }
    if(path.startsWith(records+"/")&&init.method==="DELETE"){
      assert.ok(rows.delete(path.split("/").at(-1)));return new Response(null,{status:204});
    }
    assert.fail("unexpected fixture request");
  };
  const request=async(path)=>{
    calls.push({path,ceiling});
    let data;
    if(path===base+"/_discovery")data={models:[{key:"task",access:ceiling?["read"]:["read","write"]}]};
    else if(path===records+"?limit=10")data={items:[...rows.values()]};
    else data=rows.get(path.split("/").at(-1));
    assert.ok(data);
    return {status:200,payload:{data},elapsedMs:ceiling?latency:40,
      coreRequestId:"12345678-1234-1234-1234-"+String(calls.length).padStart(12,"0")};
  };
  const evidence=async(_env,{requests})=>requests.map(x=>({
    message:"LifeSpace performance timing",service:"core",requestId:x.id,method:"GET",status:200,path:x.path.split("?")[0],
    totalMs:30,phases:{runtime:{access_check:20,discovery_state:20}},
    authorityD1:[{success:true,wallMs:20,sqlDurationMs:0.5,statements:1,rowsRead:x.mode==="read"?6:5}]
  }));
  return {fetchImpl,request,rows,phases,calls,evidence};
}
test("APAC Editor test balances 45 retained samples, restores ceiling and cleans records",async()=>{
  const f=fakeFixture();
  await runCeilingApacAcceptance(env,f.request,f.fetchImpl,f.evidence);
  assert.equal(f.calls.length,324);
  assert.equal(f.calls.filter(x=>x.ceiling==="read").length,162);
  assert.equal(f.calls.filter(x=>x.ceiling===null).length,162);
  assert.equal(f.phases.at(-1),null);
  assert.equal(f.rows.size,0);
});
test("external-only relative variation does not block when absolute and paired authority gates pass",async()=>{
  const f=fakeFixture(55);
  await runCeilingApacAcceptance(env,f.request,f.fetchImpl,f.evidence);
  assert.equal(f.phases.at(-1),null);assert.equal(f.rows.size,0);
});
test("real attributable regression, extra SQL statements, absolute regression and missing evidence block",async()=>{
  for(const kind of ["authority","sql","statements","absolute","missing"]){
    const f=fakeFixture(kind==="absolute"?300:40);
    const read=async(...args)=>{
      const rows=await f.evidence(...args);
      if(kind==="missing")return rows.slice(1);
      if(kind==="absolute")return rows;
      return rows.map((row,i)=>{
        if(args[1].requests[i].mode!=="read")return row;
        if(kind==="authority")return {...row,totalMs:40,phases:{runtime:{access_check:30,discovery_state:30}}};
        if(kind==="sql")row.authorityD1[0].sqlDurationMs=10;
        if(kind==="statements")row.authorityD1[0].statements=2;
        return row;
      });
    };
    await assert.rejects(runCeilingApacAcceptance(env,f.request,f.fetchImpl,read),/comparison blocked|Incomplete Ceiling telemetry/);
    assert.equal(f.phases.at(-1),null);assert.equal(f.rows.size,0);
  }
});

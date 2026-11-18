import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { summarize } from "./staging-canonical-performance-benchmark.mjs";
import { USER_READ_TARGETS, targetMet } from "./performance-release-targets.mjs";
import { readCeilingTelemetry, pairCeilingTelemetry } from "./ceiling-performance-evidence.mjs";

/** Only the existing run-created staging fixture and its verified principals.
 * Never accept an arbitrary Space, reuse a real family, or mutate production. */
export async function ceilingFixture(env, fetchImpl = fetch) {
  const core = env.LIFESPACE_CORE_STAGING_URL;
  const identity = env.LIFESPACE_IDENTITY_STAGING_URL;
  const space = env.LIFESPACE_STAGING_SPACE_ID;
  const ownerId = env.LIFESPACE_STAGING_SMOKE_USER_ID;
  const memberId = env.LIFESPACE_STAGING_SMOKE_CLAIMANT_USER_ID;
  const application = env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID;
  const suffix = env.GITHUB_RUN_ID + "_" + env.GITHUB_RUN_ATTEMPT;
  const owner = env.LIFESPACE_STAGING_USER_BEARER;
  const member = env.LIFESPACE_STAGING_CLAIMANT_USER_BEARER;
  const service = env.LIFESPACE_STAGING_SERVICE_BEARER;
  const secret = env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET;
  assert.equal(core, "https://core-staging.aisr.online");
  assert.equal(identity, "https://auth-staging.aisr.online");
  assert.match(suffix, /^\d+_[1-9]\d*$/u);
  assert.equal(application, "app_staging_smoke_" + suffix);
  assert.match(space ?? "", /^spc_[a-f0-9]{32}$/u);
  assert.equal(space, env.LIFESPACE_STAGING_SMOKE_CREATED_SPACE_ID);
  for (const id of [ownerId, memberId]) assert.match(id ?? "", /^usr_[A-Za-z0-9_-]+$/u);
  assert.notEqual(ownerId, memberId);
  for (const credential of [owner, member, service, secret]) assert.ok(credential, "missing fixture credential");
  const base = "/api/v1/spaces/" + space;
  const records = base + "/models/task/records";
  const config = base + "/members/" + memberId + "/model-access";
  async function call(path, bearer, status, { method = "GET", body, delegationId, baseUrl = core } = {}) {
    const response = await fetchImpl(baseUrl + path, { method, redirect: "error",
      headers: { authorization: "Bearer " + bearer,
        ...(body === undefined ? {} : {"content-type":"application/json"}),
        ...(delegationId ? {"x-lifespace-delegation-id":delegationId} : {}) },
      ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    assert.equal(response.status, status, method + " " + path + ": unexpected HTTP status");
    if (status === 204) return null;
    const payload = await response.json();
    return payload.data;
  }
  for (const [bearer, id] of [[owner,ownerId],[member,memberId]]) {
    const me = await call("/api/v1/me", bearer, 200);
    assert.equal(me.principal.type, "user");
    assert.equal(me.principal.id, id);
    assert.equal(me.principal.clientId, application);
  }
  const detail = await call(base, owner, 200);
  assert.equal(detail.id, space);
  assert.equal(detail.name, "LifeSpace staging smoke " + suffix);
  assert.equal(detail.access, "owner");
  const memberDetail = await call(base,member,200);
  assert.equal(memberDetail.access,"editor");
  const configuration = () => call(config, owner, 200);
  function find(configuration, key) {
    const row = configuration.models.find(model => model.modelKey === key);
    assert.ok(row, "missing model configuration: " + key);
    return row;
  }
  const initial = await configuration();
  assert.equal(initial.role, "editor");
  for (const key of ["task","event"]) {
    const row = find(initial,key);
    assert.equal(row.ceiling,null,"fresh run fixture must inherit");
    assert.ok(row.boundedAccess.includes("write"));
  }
  const set = (value) => call(config+"/task",owner,204,value===null?{method:"DELETE"}:{method:"PUT",body:{maxAccess:value}});
  const assertCeiling = async (value) => {
    const row = find(await configuration(),"task");
    assert.equal(row.ceiling,value);
    assert.ok(row.baseAccess.includes("write"));
    if(value==="none")assert.deepEqual(row.boundedAccess,[]);
    if(value==="read")assert.deepEqual(row.boundedAccess,["read"]);
    if(value===null)assert.ok(row.boundedAccess.includes("write"));
  };
  return {base,records,config,space,owner,member,memberId,ownerId,service,secret,identity,suffix,call,set,assertCeiling};
}

export async function runCeilingSecurityAcceptance(env,fetchImpl=fetch) {
  const f = await ceilingFixture(env,fetchImpl);
  const {call,base,records,config,owner,member,memberId,service,secret,identity,suffix,set,assertCeiling}=f;
  const create = (bearer,status,options={}) => call(records,bearer,status,{method:"POST",body:{name:"Ceiling smoke "+suffix},...options});
  let grantId, delegationId, task;
  let configured=false;
  try{
    task=await create(owner,201);
    assert.match(task.id,/^rec_/u);
    const record=records+"/"+task.id;
    const expiresAt=new Date(Date.now()+10*60_000).toISOString();
    grantId=(await call(base+"/grants",owner,201,{method:"POST",body:{
      granteeType:"user",granteeId:memberId,resourceType:"space",resourceId:null,permission:"write",expiresAt,
    }})).id;
    const agent=(await call("/internal/v1/agents",secret,201,{baseUrl:identity,method:"POST",body:{displayName:"Ceiling smoke "+suffix}})).id;
    const token=(await call("/internal/v1/agent-execution-tokens",secret,200,{baseUrl:identity,method:"POST",body:{
      agentId:agent,principalType:"user",principalId:memberId,scopes:["resources:read","resources:write"],
    }})).accessToken;
    assert.ok(token,"represented token missing");
    console.log("::add-mask::"+token);
    const issue=()=>({method:"POST",body:{actor:{type:"agent",id:agent},scope:{target:{type:"model",id:"task"},maxAccess:"write"},constraints:{expiresAt}}});
    delegationId=(await call(base+"/delegations",member,201,issue())).id;
    await call(record,member,200);
    await call(record,token,200,{delegationId});
    await call(config+"/task",member,403,{method:"PUT",body:{maxAccess:"manage"}});
    configured=true;
    await set("none");await assertCeiling("none");
    await call(record,member,403);
    await call(records+"?limit=1",member,403);
    await create(member,403);
    await create(token,403,{delegationId});
    await call(base+"/delegations",member,403,issue());
    await call(base+"/changes?recordId="+task.id,member,403);
    const manifest=await call(base+"/_discovery",member,200);
    assert.ok(!manifest.models.some(row=>row.key==="task"));
    assert.ok(manifest.models.some(row=>row.key==="event"));
    await call(base+"/_discovery/models/task",member,404);
    await call(base+"/models/event/records?limit=1",member,200);
    await call(record,owner,200);
    await call(record,service,200);
    await set("read");await assertCeiling("read");
    await call(record,member,200);
    await call(record,token,200,{delegationId});
    await create(member,403);
    await create(token,403,{delegationId});
    await set(null);configured=false;await assertCeiling(null);
    const restored=await create(token,201,{delegationId});
    await call(records+"/"+restored.id,owner,204,{method:"DELETE",body:{version:restored.version}});
    console.log(JSON.stringify({MODEL_CEILING_STAGING_SECURITY:"passed",existingUserJwt:true,representedJwt:true,
      positiveGrantBounded:true,discovery:true,history:true,unaffectedOwnerAndService:true,restored:true}));
  }finally{
    // Run-created fixture is closed by the existing always() workflow cleanup.
    // Explicitly clear/revoke here too. All cleanup operations are attempted.
    const errors=[];
    const cleanup=async(label,fn)=>{try{await fn()}catch{errors.push(label)}};
    if(configured)await cleanup("ceiling",()=>set(null));
    if(delegationId)await cleanup("delegation",()=>call(base+"/delegations/"+delegationId,member,204,{method:"DELETE"}));
    if(grantId)await cleanup("grant",()=>call(base+"/grants/"+grantId,owner,204,{method:"DELETE"}));
    if(task)await cleanup("task",()=>call(records+"/"+task.id,owner,204,{method:"DELETE",body:{version:task.version}}));
    if(errors.length)throw new Error("Ceiling smoke cleanup failed: "+errors.join(","));
  }
}

export function compareCeilingSamples(inherit,read,expected=45) {
  for(const samples of [inherit,read]){
    if(!Array.isArray(samples)||samples.length!==expected||samples.some(v=>!Number.isFinite(v)||v<0))
      throw new Error("Incomplete or invalid ceiling performance sample set");
  }
  const base=summarize(inherit),limited=summarize(read);
  const allowance=value=>Math.max(5,value*.05);
  return {inherit:base,read:limited,
    p50IncreaseMs:limited.p50Ms-base.p50Ms,p90IncreaseMs:limited.p90Ms-base.p90Ms,
    relativeMet:limited.p50Ms<=base.p50Ms+allowance(base.p50Ms)&&limited.p90Ms<=base.p90Ms+allowance(base.p90Ms)};
}

/** Fixed balanced 3×15 blocks, 3 warmups per phase, 45 retained samples per
 * scenario/state. Compare the same Editor on the same candidate and data.
 * Absolute existing Task targets remain unchanged; the relative threshold
 * applies to attributable authority work, not unrelated transport/D1 wait.
 * All raw observations remain evidence. */
export async function runCeilingApacAcceptance(env,request,fetchImpl=fetch,readEvidence=readCeilingTelemetry){
  const f=await ceilingFixture(env,fetchImpl);
  const rows=[];
  let configured=false;
  const samples={taskGet:{inherit:[],read:[]},taskList10:{inherit:[],read:[]},discovery:{inherit:[],read:[]}};
  const requests=[];
  const startedAt=Date.now();
  try{
    for(let i=0;i<10;i++)rows.push(await f.call(f.records,f.owner,201,{method:"POST",body:{name:"Ceiling APAC "+f.suffix+" "+i}}));
    const routes={taskGet:f.records+"/"+rows[0].id,taskList10:f.records+"?limit=10",discovery:f.base+"/_discovery"};
    const measure=async(mode,scenario,path,retain)=>{
      const result=await request(path);
      assert.equal(result.status,200,scenario+" "+mode);
      if(scenario==="taskGet")assert.equal(result.payload.data.id,rows[0].id);
      if(scenario==="discovery"){
        const task=result.payload.data.models.find(row=>row.key==="task");
        assert.ok(task?.access.includes("read"));
        assert.equal(task.access.includes("write"),mode==="inherit");
      }
      assert.ok(Number.isFinite(result.elapsedMs)&&result.elapsedMs>=0);
      if(retain)samples[scenario][mode].push(result.elapsedMs);
      requests.push({id:result.coreRequestId,mode,scenario,path,retained:retain,elapsedMs:result.elapsedMs});
    };
    for(let round=0;round<3;round++){
      for(const mode of (round===1?["read","inherit"]:["inherit","read"])){
        if(mode==="read"){configured=true;await f.set("read");}
        else if(configured){await f.set(null);configured=false;}
        await f.assertCeiling(mode==="read"?"read":null);
        for(const [scenario,path] of Object.entries(routes)){
          for(let i=0;i<3;i++)await measure(mode,scenario,path,false);
          for(let i=0;i<15;i++)await measure(mode,scenario,path,true);
        }
      }
    }
    const endpoints=Object.fromEntries(Object.entries(samples).map(([scenario,{inherit,read}])=>{
      const compared=compareCeilingSamples(inherit,read);
      const target=USER_READ_TARGETS[scenario];
      return [scenario,{...compared,absoluteMet:target?targetMet(compared.inherit,target)&&targetMet(compared.read,target):null}];
    }));
    // Emit all raw timings even when evidence is missing or malformed.
    console.log(JSON.stringify({MODEL_CEILING_ENDPOINT_EVIDENCE:endpoints,
      diagnostics:request.diagnostics?.()??[]},null,2));
    const evidence=pairCeilingTelemetry(requests,await readEvidence(env,{requests,startedAt,endedAt:Date.now()}));
    const outcomes=Object.fromEntries(Object.entries(endpoints).map(([scenario,endpoint])=>{
      const retained=evidence.filter(x=>x.retained&&x.scenario===scenario);
      const modes=Object.fromEntries(["inherit","read"].map(mode=>[mode,retained.filter(x=>x.mode===mode)]));
      const relative=key=>compareCeilingSamples(modes.inherit.map(x=>x[key]),modes.read.map(x=>x[key]));
      const attributable=relative("attributableMs");
      const sql=relative("d1SqlMs");
      const maxStatements=mode=>Math.max(...modes[mode].map(x=>x.statements));
      const ioMet=maxStatements("read")<=maxStatements("inherit");
      return [scenario,{endpoint,attributable,sql,authorityWall:relative("authorityMs"),
        d1Wait:relative("d1WaitMs"),core:relative("coreMs"),maxStatements:{inherit:maxStatements("inherit"),read:maxStatements("read")},
        ioMet,relativeMet:attributable.relativeMet&&sql.relativeMet&&ioMet,absoluteMet:endpoint.absoluteMet}];
    }));
    const passed=Object.values(outcomes).every(result=>result.relativeMet&&result.absoluteMet!==false);
    console.log(JSON.stringify({MODEL_CEILING_APAC:passed?"passed":"blocked",comparison:"same-candidate Editor inherit vs read; attributable authority phase and SQL",
      outcomes,evidence,diagnostics:request.diagnostics?.()??[]},null,2));
    if(!passed)throw new Error("Model ceiling APAC comparison blocked: investigate matched samples; do not weaken existing gates");
  }finally{
    const errors=[];
    if(configured){try{await f.set(null)}catch{errors.push("ceiling")}}
    for(const row of rows){try{await f.call(f.records+"/"+row.id,f.owner,204,{method:"DELETE",body:{version:row.version}})}catch{errors.push("task")}}
    if(errors.length)throw new Error("Ceiling APAC cleanup failed: "+errors.join(","));
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await runCeilingSecurityAcceptance(process.env);

import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import worker,{EventingSmokeSession,HOST,mac,PROTOCOL} from "../eventing-smoke-receiver/worker.mjs";
import {receiverClient,runReceiverSelfTest} from "./eventing-smoke-receiver-client.mjs";
const control="a".repeat(64),signing="b".repeat(64);
function fixture(){
  const objects=new Map();
  let accesses=0;
  const env={EVENTING_SMOKE_CONTROL_SECRET:control,SESSIONS:{
    idFromName:id=>id,
    get(id){
      accesses++;
      if(!objects.has(id)){
        const data=new Map();
        const storage={alarm:null,async get(k){return structuredClone(data.get(k));},async put(k,v){data.set(k,structuredClone(v));},async deleteAll(){data.clear();},async setAlarm(v){this.alarm=v;},async deleteAlarm(){this.alarm=null;}};
        const instance=new EventingSmokeSession({storage,blockConcurrencyWhile:fn=>fn()});
        objects.set(id,{instance,storage,data});
      }
      return objects.get(id).instance;
    }
  }};
  const fetcher=(url,init)=>worker.fetch(new Request(url,init),env);
  const client=receiverClient({secret:control,sessionId:"1".repeat(32),fetcher});
  const other=receiverClient({secret:control,sessionId:"2".repeat(32),fetcher});
  return {env,fetcher,client,other,objects,accesses:()=>accesses};
}
const input={signingSecret:signing,spaceId:"spc_fixture",endpointId:"whk_fixture",subscriptionId:"sub_fixture",subscriberServicePrincipalId:"svc_fixture"};
function event(overrides={}){
  return {id:"evt_fixture",type:"record.created",spaceId:input.spaceId,modelKey:"event",recordId:"rec_fixture",recordVersion:1,changeId:"chg_fixture",occurredAt:new Date().toISOString(),...overrides};
}
function endpointTest(){
  return {id:"test_fixture",type:"endpoint.test",endpointId:input.endpointId,spaceId:input.spaceId,subscriberServicePrincipalId:input.subscriberServicePrincipalId,occurredAt:new Date().toISOString()};
}
async function send(f,payload,{client=f.client,secret=signing,headers={},timestamp=String(Math.floor(Date.now()/1000)),isTest=false}={}){
  const body=JSON.stringify(payload);
  return f.fetcher(client.url,{method:"POST",headers:{"content-type":"application/json","x-lifespace-timestamp":timestamp,
    "x-lifespace-signature":"v1="+createHmac("sha256",secret).update(timestamp+"."+body).digest("hex"),
    "x-lifespace-webhook-endpoint-id":input.endpointId,
    ...(isTest?{"x-lifespace-test":"true"}:{"x-lifespace-event-id":payload.id,"x-lifespace-delivery-id":"dlv_fixture","x-lifespace-subscription-id":input.subscriptionId}),...headers},body});
}
test("independent HMAC implementation and authenticated session isolation",async()=>{
  const f=fixture();
  assert.equal(await mac(control,"test"),createHmac("sha256",control).update("test").digest("hex"));
  await f.client.ready();
  assert.equal((await f.fetcher("https://"+HOST+"/control/ready")).status,401);
  assert.equal((await f.fetcher("https://"+HOST+"/webhook/"+"a".repeat(32)+"."+"b".repeat(64),{method:"POST"})).status,404);
  assert.equal(f.accesses(),0);
  await f.client.create(input);
  await f.other.create({...input,signingSecret:"c".repeat(64)});
  await assert.rejects(()=>f.client.create(input),/HTTP 409/);
  const receipt=await f.client.receipts();
  assert.equal(receipt.protocol,PROTOCOL);
  assert.equal(receipt.testCount,0);
  assert.deepEqual(receipt.receipts,[]);
  assert.ok(!JSON.stringify(receipt).includes(signing));
  assert.equal((await send(f,endpointTest(),{isTest:true})).status,204);
  assert.equal((await send(f,event())).status,204);
  assert.equal((await send(f,event())).status,204);
  assert.equal((await f.client.receipts()).testCount,1);
  assert.deepEqual((await f.client.receipts()).receipts,[{deliveryId:"dlv_fixture",eventId:"evt_fixture",recordId:"rec_fixture",recordVersion:1,changeId:"chg_fixture"}]);
  assert.equal((await send(f,event(),{client:f.other})).status,401);
  assert.deepEqual((await f.other.receipts()).receipts,[]);
  await f.client.remove();
  assert.equal((await send(f,event())).status,404);
  assert.equal((await f.other.receipts()).testCount,0);
  await f.other.remove();
});
test("invalid HMAC, stale timestamp, payload extras and cross-session references cannot record a receipt",async()=>{
  const f=fixture();await f.client.create(input);
  assert.equal((await send(f,event(),{secret:"d".repeat(64)})).status,401);
  assert.equal((await send(f,event(),{timestamp:"1"})).status,401);
  assert.equal((await send(f,event({recordBody:"private"}))).status,400);
  assert.equal((await send(f,event({spaceId:"spc_other"}))).status,400);
  assert.equal((await send(f,event(),{headers:{"x-lifespace-subscription-id":"sub_other"}})).status,400);
  assert.equal((await send(f,endpointTest(),{isTest:true,headers:{"x-lifespace-webhook-endpoint-id":"whk_other"}})).status,400);
  assert.equal((await send(f,event({recordId:"rec_other"}),{headers:{"x-lifespace-event-id":"evt_other"}})).status,400);
  assert.equal((await send(f,event({recordId:"x".repeat(17000)}))).status,400);
  assert.equal((await f.client.receipts()).testCount,0);
  assert.deepEqual((await f.client.receipts()).receipts,[]);
});
test("expiry and alarm remove credentials and receipts; duplicate delivery conflict fails closed",async()=>{
  const f=fixture();await f.client.create(input);
  assert.equal((await send(f,event())).status,204);
  assert.equal((await send(f,event({recordId:"rec_different"}))).status,409);
  const obj=f.objects.get(f.client.sessionId);
  assert.ok(obj.storage.alarm>Date.now());
  await obj.instance.alarm();
  assert.equal(obj.data.size,1);
  obj.data.get("session").expiresAt=Date.now()-1;
  await obj.instance.alarm();
  assert.equal(obj.data.size,0);
  assert.equal(obj.storage.alarm,null);
  assert.equal((await send(f,event())).status,404);
  await f.other.create(input);
  f.objects.get(f.other.sessionId).data.get("session").expiresAt=Date.now()-1;
  assert.equal((await send(f,event(),{client:f.other})).status,404);
  assert.equal(f.objects.get(f.other.sessionId).data.size,0);
});
test("canonical workflow preflights without provisioning and requires both acceptance steps",()=>{
  const read=p=>readFileSync(new URL(p,import.meta.url),"utf8");
  const workflow=read("../../.github/workflows/staging-deploy.yml");
  const independent=read("../../.github/workflows/staging-eventing-receiver-deploy.yml");
  const verifier=read("./verify-staging-eventing.mjs");
  assert.ok(workflow.indexOf("Verify fixed Staging Eventing receiver before mutation")<workflow.indexOf("Apply Core migrations"));
  assert.match(workflow,/id: eventing_positive/);
  assert.match(workflow,/!cancelled\(\).*steps\.eventing_positive\.outcome == 'success'.*steps\.eventing_positive\.outcome == 'failure'/);
  assert.doesNotMatch(workflow,/staging-eventing-receiver-deploy\.yml|eventing-smoke-receiver\/wrangler/);
  assert.doesNotMatch(verifier,/workers\/domains|workers\/scripts|deploySink/);
  assert.match(verifier,/Real delivery 204 has no unique matching receiver receipt/);
  assert.match(independent,/GITHUB_TRIGGERING_ACTOR.*huangshirui/);
  assert.match(independent,/group: lifespace-staging-deploy/);
  assert.match(independent,/--self-test --verify-only/);
  assert.match(independent,/name: Deploy independent staging receiver\n\s+if: inputs\.mode == 'deploy'/);
  const config=JSON.parse(read("../eventing-smoke-receiver/wrangler.jsonc"));
  assert.equal(config.workers_dev,false);
  assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[{pattern:HOST,custom_domain:true}]);
  assert.deepEqual(config.durable_objects.bindings,[{name:"SESSIONS",class_name:"EventingSmokeSession"}]);
  assert.ok(!config.d1_databases&&!config.services&&!config.env);
});

test("verify existing receiver exercises exact signature denial and receipt without provisioning",async()=>{
  const f=fixture();
  await runReceiverSelfTest(f.client,{fetcher:f.fetcher});
  assert.equal(f.objects.get(f.client.sessionId).data.size,0);
});
test("self-test reports sanitized HTTP and CF-Ray, never retries a failed signed request or accepts arbitrary 401",async()=>{
  for(const status of [500,401]){
    const f=fixture();
    let sent=0;
    const fetcher=async(url,init)=>{
      sent++;
      return new Response("edge error", {status,headers:{"cf-ray":"a5bef8dec811ce94-SJC"}});
    };
    await assert.rejects(()=>runReceiverSelfTest(f.client,{fetcher}),error=>{
      assert.match(error.message,new RegExp("HTTP "+status+" CF-Ray a5bef8dec811ce94-SJC"));
      assert.ok(!error.message.includes(f.client.url));
      assert.ok(!error.message.includes(control));
      return true;
    });
    assert.equal(sent,1);
    assert.equal(f.objects.get(f.client.sessionId).data.size,0);
  }
});


// Execute the actual top-level verifier (not a reimplemented sequence). Only
// platform HTTP is simulated; the real receiver client, HMAC and Worker/DO
// session logic run in-process. All network destinations must match fixtures.
test("full staging Eventing verifier wires returned subscriber, Endpoint, Grant and signed delivery receipt through cleanup",async()=>{
  const f=fixture();
  const env={
    LIFESPACE_IDENTITY_STAGING_URL:"https://auth-staging.aisr.online",
    LIFESPACE_CORE_STAGING_URL:"https://core-staging.aisr.online",
    LIFESPACE_STAGING_SMOKE_APPLICATION_ID:"app_fixture",
    LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET:"fixture_application_secret",
    LIFESPACE_STAGING_SMOKE_USER_ID:"usr_fixture",
    LIFESPACE_STAGING_SPACE_ID:input.spaceId,
    LIFESPACE_STAGING_PERSON_ID:"per_fixture",
    EVENTING_SMOKE_CONTROL_SECRET:control,
  };
  const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  const originalFetch=globalThis.fetch;
  let endpointUrl,grant=false,subscription=false,eventCreated=false,endpoint=false,principal=false,grantDenials=0,testSends=0,deliverySends=0,sessionRegistrations=0;
  const data=(value,status=200)=>Response.json({data:value},{status});
  const denied=()=>{grantDenials++;return Response.json({error:{code:"EVENT_SUBSCRIBER_ACCESS_DENIED"}},{status:403});};
  const empty=()=>new Response(null,{status:204});
  const token="fixture_user_bearer";
  const signed=async(payload,isTest)=>{
    const body=JSON.stringify(payload);
    const timestamp=String(Math.floor(Date.now()/1000));
    return f.fetcher(endpointUrl,{method:"POST",headers:{
      "content-type":"application/json","x-lifespace-timestamp":timestamp,
      "x-lifespace-signature":"v1="+createHmac("sha256",signing).update(timestamp+"."+body).digest("hex"),
      "x-lifespace-webhook-endpoint-id":input.endpointId,
      ...(isTest?{"x-lifespace-test":"true"}:{"x-lifespace-event-id":payload.id,"x-lifespace-delivery-id":"dlv_fixture","x-lifespace-subscription-id":input.subscriptionId}),
    },body});
  };
  Object.assign(process.env,env);
  globalThis.fetch=async(url,init={})=>{
    const u=new URL(url),method=init.method??"GET",path=u.pathname;
    const body=init.body===undefined?undefined:JSON.parse(init.body);
    const auth=new Headers(init.headers).get("authorization");
    if(u.hostname===HOST){
      if(method==="PUT"&&path.startsWith("/control/sessions/")){
        sessionRegistrations++;
        assert.deepEqual(body,input);
      }
      return f.fetcher(url,init);
    }
    if(u.hostname==="auth-staging.aisr.online"){
      assert.equal(auth,"Bearer "+env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET);
      if(method==="GET"&&path==="/internal/v1/applications/self")return data({id:env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID,trustedBackend:true,status:"active",allowedScopes:["spaces:manage","grants:manage","resources:read","resources:write"]});
      if(method==="POST"&&path==="/internal/v1/tokens"){assert.equal(body.subjectId,env.LIFESPACE_STAGING_SMOKE_USER_ID);return data({accessToken:token});}
      if(method==="POST"&&path==="/api/v1/service-principals"){principal=true;return data({id:input.subscriberServicePrincipalId},201);}
      if(method==="PATCH"&&path==="/api/v1/service-principals/"+input.subscriberServicePrincipalId){assert.equal(body.status,"disabled");principal=false;return data({status:"disabled"});}
      throw Error("unexpected Identity fixture route");
    }
    assert.equal(u.hostname,"core-staging.aisr.online");
    assert.equal(auth,"Bearer "+token);
    const base="/api/v1/webhook-endpoints",ep=base+"/"+input.endpointId,sub="/api/v1/event-subscriptions",subPath=sub+"/"+input.subscriptionId,space="/api/v1/spaces/"+input.spaceId,gr=space+"/grants",records=space+"/models/event/records";
    if(method==="POST"&&path===base){
      assert.equal(body.subscriberServicePrincipalId,input.subscriberServicePrincipalId);assert.equal(body.spaceId,input.spaceId);
      endpointUrl=body.webhookUrl;assert.equal(new URL(endpointUrl).hostname,HOST);endpoint=true;
      return data({id:input.endpointId,signingSecret:signing},201);
    }
    if(method==="GET"&&path===base)return data({items:[{id:input.endpointId,signingConfigured:true}]});
    if(method==="POST"&&path===sub){assert.equal(body.endpointId,input.endpointId);if(!grant)return denied();subscription=true;return data({id:input.subscriptionId,endpointId:input.endpointId,modelKey:"event"},201);}
    if(method==="POST"&&path===gr){assert.equal(body.granteeId,input.subscriberServicePrincipalId);grant=true;return data({id:"grt_fixture"},201);}
    if(method==="GET"&&path===sub)return data({items:[{id:input.subscriptionId,endpointId:input.endpointId,modelKey:"event"}]});
    if(method==="POST"&&path===ep+"/test"){
      assert.equal(endpoint,true);assert.equal(grant,testSends===0);
      const response=await signed(endpointTest(),true);testSends++;
      return data({ok:response.ok,statusCode:response.status});
    }
    if(method==="POST"&&path===records){assert.ok(grant&&subscription);eventCreated=true;return data({id:"rec_fixture",version:1},201);}
    if(method==="GET"&&path===ep+"/deliveries"){
      assert.ok(eventCreated&&grant);const response=await signed(event(),false);deliverySends++;
      assert.equal(response.status,204);
      return data({items:[{id:"dlv_fixture",eventId:"evt_fixture",recordId:"rec_fixture",recordVersion:1,changeId:"chg_fixture",modelKey:"event",eventType:"record.created",status:"succeeded",attemptCount:1,lastStatusCode:204}]});
    }
    if(method==="DELETE"&&path===gr+"/grt_fixture"){grant=false;return empty();}
    if(method==="PATCH"&&path===subPath){assert.equal(grant,false);return denied();}
    if(method==="DELETE"&&path===subPath){subscription=false;return empty();}
    if(method==="DELETE"&&path===ep){endpoint=false;return empty();}
    if(method==="DELETE"&&path===records+"/rec_fixture"){assert.equal(body.version,1);eventCreated=false;return empty();}
    throw Error("unexpected Core fixture route "+method);
  };
  try {
    await import("./verify-staging-eventing.mjs?full-verifier-fixture");
    assert.equal(sessionRegistrations,1);
    assert.equal(grantDenials,2);
    assert.equal(testSends,2);
    assert.equal(deliverySends,1);
    assert.equal(f.objects.size,1);
    for(const obj of f.objects.values()){assert.equal(obj.data.size,0);assert.equal(obj.storage.alarm,null);}
    assert.deepEqual({grant,subscription,eventCreated,endpoint,principal},{grant:false,subscription:false,eventCreated:false,endpoint:false,principal:false});
  } finally {
    globalThis.fetch=originalFetch;
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});

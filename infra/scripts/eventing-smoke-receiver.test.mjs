import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import worker,{EventingSmokeSession,HOST,mac,PROTOCOL} from "../eventing-smoke-receiver/worker.mjs";
import {receiverClient} from "./eventing-smoke-receiver-client.mjs";
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
  assert.match(independent,/--self-test/);
  const config=JSON.parse(read("../eventing-smoke-receiver/wrangler.jsonc"));
  assert.equal(config.workers_dev,false);
  assert.equal(config.preview_urls,false);
  assert.deepEqual(config.routes,[{pattern:HOST,custom_domain:true}]);
  assert.deepEqual(config.durable_objects.bindings,[{name:"SESSIONS",class_name:"EventingSmokeSession"}]);
  assert.ok(!config.d1_databases&&!config.services&&!config.env);
});

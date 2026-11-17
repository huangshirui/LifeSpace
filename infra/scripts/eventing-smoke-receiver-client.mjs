import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { registerRunnerSecret as mask } from "./runner-secret.mjs";
import { HOST, PROTOCOL } from "../eventing-smoke-receiver/worker.mjs";

export function receiverClient({ secret=process.env.EVENTING_SMOKE_CONTROL_SECRET, fetcher=fetch, sessionId=randomBytes(16).toString("hex") }={}) {
  if (!/^[a-f0-9]{64}$/u.test(secret??"") || !/^[a-f0-9]{32}$/u.test(sessionId)) throw Error("Staging Eventing receiver control credential is missing or malformed");
  const base="https://"+HOST;
  const tag=createHmac("sha256",secret).update("eventing-smoke-route-v1:"+sessionId).digest("hex");
  const url=base+"/webhook/"+sessionId+"."+tag;
  // Path is a limited capability; never print it, even in runner errors.
  mask(tag); mask(url);
  const control=async(path,method="GET",body)=>{
    let response;
    try {response=await fetcher(base+"/control/"+path,{method,headers:{authorization:"Bearer "+secret,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});}
    catch(error) {const code=error?.cause?.code??error?.name;throw Error("Eventing receiver control transport failed ("+(/^[A-Z_a-z0-9]{1,60}$/u.test(code??"")?code:"unknown")+")");}
    const status=response.status;
    if (status===204) return {status};
    let payload;try{payload=await response.json();}catch{throw Error("Eventing receiver invalid response (HTTP "+status+")");}
    if (![200,201].includes(status)||payload?.protocol!==PROTOCOL) throw Error("Eventing receiver control rejected (HTTP "+status+")");
    return {status,payload};
  };
  const path="sessions/"+sessionId;
  return {url,sessionId,
    async ready(){const {status,payload}=await control("ready");if(status!==200||payload?.ready!==true)throw Error("Eventing receiver not ready");},
    async create(input){const {status,payload}=await control(path,"PUT",input);if(status!==201||!Number.isFinite(payload?.expiresAt)||payload.expiresAt<=Date.now())throw Error("Eventing receiver session registration failed");},
    async receipts(){const {status,payload}=await control(path);if(status!==200||!Number.isInteger(payload?.testCount)||!Array.isArray(payload?.receipts))throw Error("Eventing receiver receipt invalid");return payload;},
    async remove(){const {status}=await control(path,"DELETE");if(status!==204)throw Error("Eventing receiver session cleanup failed");},
  };
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  // Bounded preflight; no platform credentials, no receiver deploy or domain change.
  const client=receiverClient();
  if (process.argv.includes("--self-test")) {
    // Only the independent receiver deployment waits for DNS/TLS convergence.
    // Core's normal deployment never provisions or retries receiver creation.
    let last;
    for (let i=0;i<30;i++) {
      try {await client.ready();last=undefined;break;} catch(error) {last=error;}
      if (i<29) await new Promise(resolve=>setTimeout(resolve,3000));
    }
    if (last) throw last;
    const signingSecret=randomBytes(32).toString("hex");
    mask(signingSecret);
    const fixture={signingSecret,spaceId:"spc_receiver_selftest",endpointId:"whk_receiver_selftest",subscriptionId:"sub_receiver_selftest",subscriberServicePrincipalId:"svc_receiver_selftest"};
    try {
      await client.create(fixture);
      const body=JSON.stringify({id:"test_receiver_selftest",type:"endpoint.test",endpointId:fixture.endpointId,spaceId:fixture.spaceId,subscriberServicePrincipalId:fixture.subscriberServicePrincipalId,occurredAt:new Date().toISOString()});
      const timestamp=String(Math.floor(Date.now()/1000));
      const signature="v1="+createHmac("sha256",signingSecret).update(timestamp+"."+body).digest("hex");
      const headers={"content-type":"application/json","x-lifespace-timestamp":timestamp,"x-lifespace-test":"true","x-lifespace-webhook-endpoint-id":fixture.endpointId};
      const send=sig=>fetch(client.url,{method:"POST",headers:{...headers,"x-lifespace-signature":sig},body,signal:AbortSignal.timeout(10000)});
      if ((await send("v1="+"0".repeat(64))).status!==401) throw Error("Receiver invalid HMAC self-test failed");
      if ((await send(signature)).status!==204) throw Error("Receiver signed HTTPS self-test failed");
      const receipt=await client.receipts();
      if (receipt.testCount!==1||receipt.receipts.length!==0) throw Error("Receiver self-test receipt mismatch");
    } finally {await client.remove();}
  } else await client.ready();
  console.log(JSON.stringify({eventingReceiver:HOST,protocol:PROTOCOL,ready:true,selfTest:process.argv.includes("--self-test")}));
}

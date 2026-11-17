import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { registerRunnerSecret as mask } from "./runner-secret.mjs";
import { HOST, PROTOCOL } from "../eventing-smoke-receiver/worker.mjs";

function responseEvidence(response) {
  const ray=response.headers.get("cf-ray")??"";
  return "HTTP "+response.status+(/^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/u.test(ray)?" CF-Ray "+ray:"");
}
function transportError(label,error) {
  const code=error?.cause?.code??error?.name;
  return Error(label+" transport failed ("+(/^[A-Za-z0-9_]{1,60}$/u.test(code??"")?code:"unknown")+")");
}

export function receiverClient({ secret=process.env.EVENTING_SMOKE_CONTROL_SECRET, fetcher=fetch, sessionId=randomBytes(16).toString("hex") }={}) {
  if (!/^[a-f0-9]{64}$/u.test(secret??"") || !/^[a-f0-9]{32}$/u.test(sessionId)) throw Error("Staging Eventing receiver control credential is missing or malformed");
  const base="https://"+HOST;
  const tag=createHmac("sha256",secret).update("eventing-smoke-route-v1:"+sessionId).digest("hex");
  const url=base+"/webhook/"+sessionId+"."+tag;
  // Path is a limited capability; never print it, even in runner errors.
  mask(tag); mask(url);
  const control=async(path,method="GET",body)=>{
    let response;
    try {response=await fetcher(base+"/control/"+path,{method,headers:{authorization:"Bearer "+secret,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:"error",signal:AbortSignal.timeout(10000)});}
    catch(error) {throw transportError("Eventing receiver control "+method,error);}
    const status=response.status;
    if (status===204) return {status};
    let payload;try{payload=await response.json();}catch{throw Error("Eventing receiver invalid response ("+responseEvidence(response)+")");}
    if (![200,201].includes(status)||payload?.protocol!==PROTOCOL) throw Error("Eventing receiver control rejected ("+responseEvidence(response)+")");
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
// Same real HTTPS checks for initial deployment and existing-receiver verification.
// Neither mode retries signed traffic or treats an edge denial as receiver HMAC proof.
export async function runReceiverSelfTest(client,{fetcher=fetch,waitForDeployment=false}={}) {
  if (waitForDeployment) {
    let last;
    for (let i=0;i<30;i++) {
      try {await client.ready();last=undefined;break;} catch(error) {last=error;}
      if (i<29) await new Promise(resolve=>setTimeout(resolve,3000));
    }
    if (last) throw last;
  } else await client.ready();
  const signingSecret=randomBytes(32).toString("hex");
  mask(signingSecret);
  const fixture={signingSecret,spaceId:"spc_receiver_selftest",endpointId:"whk_receiver_selftest",subscriptionId:"sub_receiver_selftest",subscriberServicePrincipalId:"svc_receiver_selftest"};
  let primary;
  try {
    await client.create(fixture);
    const body=JSON.stringify({id:"test_receiver_selftest",type:"endpoint.test",endpointId:fixture.endpointId,spaceId:fixture.spaceId,subscriberServicePrincipalId:fixture.subscriberServicePrincipalId,occurredAt:new Date().toISOString()});
    const timestamp=String(Math.floor(Date.now()/1000));
    const signature="v1="+createHmac("sha256",signingSecret).update(timestamp+"."+body).digest("hex");
    const headers={"content-type":"application/json","x-lifespace-timestamp":timestamp,"x-lifespace-test":"true","x-lifespace-webhook-endpoint-id":fixture.endpointId};
    const send=async(sig,label)=>{
      try {return await fetcher(client.url,{method:"POST",headers:{...headers,"x-lifespace-signature":sig},body,redirect:"error",signal:AbortSignal.timeout(10000)});}
      catch(error){throw transportError(label,error);}
    };
    const denied=await send("v1="+"0".repeat(64),"Receiver invalid HMAC");
    if (denied.status!==401) throw Error("Receiver invalid HMAC self-test failed ("+responseEvidence(denied)+")");
    let denial;
    try {denial=await denied.json();} catch {throw Error("Receiver invalid HMAC denial is not JSON ("+responseEvidence(denied)+")");}
    if (denial?.code!=="signature") throw Error("Receiver invalid HMAC denial is not signature-specific ("+responseEvidence(denied)+")");
    const before=await client.receipts();
    if (before.testCount!==0||before.receipts.length!==0) throw Error("Receiver invalid HMAC created a receipt");
    const accepted=await send(signature,"Receiver signed HTTPS");
    if (accepted.status!==204) throw Error("Receiver signed HTTPS self-test failed ("+responseEvidence(accepted)+")");
    const receipt=await client.receipts();
    if (receipt.testCount!==1||receipt.receipts.length!==0) throw Error("Receiver self-test receipt mismatch");
  } catch(error){primary=error;}
  finally {
    try {await client.remove();} catch(error){if(primary)throw Error(primary.message+"; cleanup: "+error.message);throw error;}
  }
  if(primary)throw primary;
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const client=receiverClient();
  const selfTest=process.argv.includes("--self-test");
  if (selfTest) await runReceiverSelfTest(client,{waitForDeployment:!process.argv.includes("--verify-only")});
  else await client.ready();
  console.log(JSON.stringify({eventingReceiver:HOST,protocol:PROTOCOL,ready:true,selfTest}));
}

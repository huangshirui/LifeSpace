import { HOST } from "../eventing-smoke-receiver/worker.mjs";
const {CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:account,EVENTING_SMOKE_CONTROL_SECRET:secret}=process.env;
if (!token||!(/^[a-f0-9]{32}$/u.test(account??""))||!(/^[a-f0-9]{64}$/u.test(secret??""))) throw Error("Missing or invalid staging receiver credentials");
const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+account+"/workers/domains",{headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(10000)});
const payload=await response.json();
if (!response.ok||payload.success!==true||!Array.isArray(payload.result)) throw Error("Cannot verify receiver Custom Domain ownership");
if (payload.result.some(item=>item.hostname===HOST && item.service!=="lifespace-eventing-smoke-staging")) throw Error("Receiver hostname belongs to another Worker; refusing mutation");
console.log("Fixed staging receiver hostname ownership verified");

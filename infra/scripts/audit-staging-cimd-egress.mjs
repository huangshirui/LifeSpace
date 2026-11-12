// Read-only deployment audit: network and mandatory limiter prerequisites,
// not feature switches. Current feature policy lives only in Identity D1.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WORKERS = {staging:"lifespace-identity-staging",production:"lifespace-identity"};
const STRICT_PUBLIC_FLAG = "global_fetch_strictly_public";
const LIMITERS = ["OAUTH_DCR_RATE_LIMITER","OAUTH_AUTHORIZE_RATE_LIMITER"];
export function assessCimdStaging(settings = {}, environment = "staging") {
  assert.ok(Object.hasOwn(WORKERS,environment),"Unknown Identity environment");
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const flags = Array.isArray(settings.compatibility_flags) ? settings.compatibility_flags : [];
  const networkBindings = bindings.filter(b => ["vpc_network","vpc_service","hyperdrive"].includes(b.type)
    || b.name?.startsWith("OAUTH_CIMD_EGRESS"));
  const legacySwitches = bindings.filter(b => ["OAUTH_CIMD_ENABLED","OAUTH_DCR_ENABLED"].includes(b.name));
  const strictPublicFetch = flags.includes(STRICT_PUBLIC_FLAG) && !flags.includes("global_fetch_private_origin");
  const missingLimiters = LIMITERS.filter(name => !bindings.some(b => b.name===name && b.type==="ratelimit"));
  const safe = strictPublicFetch && networkBindings.length===0 && legacySwitches.length===0 && missingLimiters.length===0;
  return {safe,worker:WORKERS[environment],strictPublicFetch,
    networkBindings:networkBindings.map(b=>({name:b.name,type:b.type})),
    legacySwitches:legacySwitches.map(b=>b.name),missingLimiters,
    status:safe?"NATIVE_CONFIGURED":"RELEASE_GATE_FAILED",
    note:"Configuration gate only; Console D1 policy controls admission. Live admission and DNS preflight do not prove connection pinning."};
}
export async function auditCimdStaging({accountId,token,getSettings,environment="staging"}={}) {
  assert.match(accountId||"",/^[a-f0-9]{32}$/u,"Cloudflare account ID required");
  assert.ok(typeof token==="string"&&token.length>5,"Cloudflare API token required");
  assert.ok(Object.hasOwn(WORKERS,environment),"Unknown Identity environment");
  const fetchSettings=getSettings||(async()=>{
    const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKERS[environment]}/settings`,{
      headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000),redirect:"error"});
    const data=await response.json().catch(()=>null);
    if(!response.ok||data?.success!==true) throw Error(`Cloudflare Identity read-only audit failed (HTTP ${response.status})`);
    return data.result;
  });
  return assessCimdStaging(await fetchSettings(),environment);
}
async function main(){
  const environment=process.argv.includes("--production")?"production":"staging";
  const result=await auditCimdStaging({accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,environment});
  console.log("Identity CIMD configuration audit: "+JSON.stringify(result));
  if(process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    "\n## Identity CIMD public-only network gate\n- Environment: "+environment+
    "\n- Strict-public: "+result.strictPublicFetch+"\n- Result: **"+result.status+"**\n"+
    "- No feature switch is set by this gate; Console is the sole admission policy.\n");
  if(!result.safe) throw Error("Identity requires strict-public fetch, both limiters, no private/relay bindings and no legacy admission switches");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])) await main();

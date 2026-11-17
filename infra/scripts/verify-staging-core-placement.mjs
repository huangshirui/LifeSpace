import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

export function placementKey(placement){
  if(placement?.mode==="smart"&&!placement.region&&!placement.target&&!placement.host&&!placement.hostname)return "smart";
  const region=placement?.region??(Array.isArray(placement?.target)&&placement.target.length===1?placement.target[0]?.region:null);
  if((placement?.mode===undefined||placement.mode==="targeted")&&region==="aws:ap-southeast-1")return region;
  throw Error("Unknown or unsupported Core placement; fail closed");
}
export function assertPlacement({staging,production,live,requireProductionParity=false}){
  const desired=placementKey(staging),prod=placementKey(production),actual=placementKey(live);
  if(desired!==actual)throw Error("Live staging Core placement differs from candidate");
  if(requireProductionParity&&desired!==prod)throw Error("Staging placement experiment differs from production candidate; restore parity before production promotion");
  return {staging:desired,production:prod,live:actual,productionParity:desired===prod};
}
async function main(){
  const config=JSON.parse(readFileSync(new URL("../../apps/core/wrangler.jsonc",import.meta.url),"utf8"));
  const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN;
  if(!account||!token)throw Error("Cloudflare account and API token required");
  const response=await fetch("https://api.cloudflare.com/client/v4/accounts/"+encodeURIComponent(account)+"/workers/scripts/lifespace-core-staging/settings",{headers:{authorization:"Bearer "+token},redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error("Read-only staging Core settings failed HTTP "+response.status);
  const data=await response.json();if(data?.success!==true)throw Error("Read-only staging Core settings unavailable");
  console.log(JSON.stringify({APAC_CORE_PLACEMENT:assertPlacement({staging:config.env.staging.placement,production:config.env.production.placement,live:data.result?.placement,requireProductionParity:process.argv.includes("--require-production-parity")})}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();

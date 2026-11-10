// Read-only Account Staging Access preflight for ordinary code-only deployments.
// Provisioning and policy changes belong to the separate owner-confirmed workflow.
import process from "node:process";
import { pathToFileURL } from "node:url";
import { ACCOUNT_DOMAIN, requireSingle, assertAccountAccess } from "./prepare-staging-access.mjs";

export async function verifyExistingStagingAccess({env=process.env,fetcher=fetch}={}){
  const account=env.CLOUDFLARE_ACCOUNT_ID || "", token=env.CLOUDFLARE_API_TOKEN || "";
  if(!/^[0-9a-f]{32}$/iu.test(account)||!token)
    throw new Error("Cloudflare read-only Account Access inspection requires protected credentials");
  const base="https://api.cloudflare.com/client/v4/accounts/"+account;
  async function get(path){
    const res=await fetcher(base+path,{method:"GET",headers:{
      authorization:"Bearer "+token,accept:"application/json",
    }});
    const body=await res.json().catch(()=>null);
    if(!res.ok||body?.success!==true)
      throw new Error("Account Staging Access inspection failed (HTTP "+res.status+")");
    return body.result;
  }
  const apps=await get("/access/apps?per_page=100");
  const app=requireSingle(apps,ACCOUNT_DOMAIN);
  if(!app||typeof app.id!=="string"||!app.id)
    throw new Error("Account Access app missing; use explicit provisioning workflow");
  const details=await get("/access/apps/"+encodeURIComponent(app.id));
  const policies=await get("/access/apps/"+encodeURIComponent(app.id)+"/policies");
  if(details?.id!==app.id)
    throw new Error("Account Access app changed during read-only verification");
  const audience=assertAccountAccess(details,policies);
  if(app.aud!==audience)
    throw new Error("Account Access audience changed during read-only verification");
  return {ok:true,domain:ACCOUNT_DOMAIN,verifiedOwnerOnlyPolicies:policies.length,
    audiencePresent:true,mutation:false,accountD1Created:false,noProductionChanges:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log(JSON.stringify(await verifyExistingStagingAccess(),null,2));
}

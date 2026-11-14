// Owner-only recovery: verify the existing protected Identity Resource Secret,
// then repair ONLY the private Production Adapter if the live wire rejects it.
// Never read Worker secret values, create credentials, or rotate Identity.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import process from "node:process";

const CORE = "https://core.aisr.online";
const IDENTITY = "https://auth.aisr.online";
const NAME = "OAUTH_RESOURCE_SERVER_SECRET";
const WORKERS = ["lifespace-identity","lifespace-core","lifespace-mcp-adapter"];
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
function ensure(ok,message) { if(!ok) throw new Error(message); }
export function productionResource(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Exact Production MCP resource URI required"); }
  ensure(url.origin===CORE && /^\/mcp\/mcp_[a-f0-9]{32}$/u.test(url.pathname)
    && !url.username && !url.password && !url.search && !url.hash && url.href===value,
    "Only an exact canonical Production MCP resource is accepted");
  return url.href;
}
export async function repairProductionMcpResourceSecret({
  accountId, token, resourceUri, resourceSecret, confirmation, request=fetch,
  sleep=pause, attempts=15,
}={}) {
  const resource=productionResource(resourceUri);
  ensure(confirmation==="REPAIR_MCP_RESOURCE_SECRET","Explicit owner repair confirmation required");
  ensure(typeof accountId==="string" && /^[a-f0-9]{32}$/u.test(accountId)
    && typeof token==="string" && token.length>=20,"Protected Cloudflare credentials required");
  ensure(typeof resourceSecret==="string" && resourceSecret.length>=32,
    "Protected canonical Production OAuth Resource Secret required");
  const origin="https://api.cloudflare.com/client/v4/accounts/"+accountId+"/workers/scripts";
  const cfHeaders={authorization:"Bearer "+token,accept:"application/json"};
  const call=async (url,init,label)=>{
    try { return await request(url,{...init,redirect:"manual",signal:AbortSignal.timeout(10000)}); }
    catch { throw new Error(label+" request unavailable"); }
  };
  const cf=async (name,suffix,init={})=>{
    const response=await call(origin+"/"+name+"/"+suffix,{...init,headers:{...cfHeaders,...init.headers}},"Cloudflare "+name);
    const payload=await response.json().catch(()=>null);
    ensure(response.ok&&payload?.success===true,"Cloudflare "+name+" "+suffix+" failed");
    return payload.result;
  };
  const settings=await Promise.all(WORKERS.map(name=>cf(name,"settings")));
  const [identity,core,adapter]=settings.map(s=>s?.bindings);
  const service=(bindings,name,target)=>Array.isArray(bindings)&&bindings.some(b=>b.name===name&&b.type==="service"&&b.service===target);
  const secret=bindings=>Array.isArray(bindings)&&bindings.some(b=>b.name===NAME&&b.type==="secret_text");
  ensure(secret(identity)&&secret(adapter)&&service(identity,"CORE","lifespace-core")
    &&service(core,"IDENTITY","lifespace-identity")&&service(core,"MCP_ADAPTER","lifespace-mcp-adapter")
    &&service(adapter,"IDENTITY","lifespace-identity")&&service(adapter,"CORE","lifespace-core"),
    "Production Worker binding inventory is missing or cross-environment; stop without mutation");

  const fake="lsp_oat_"+randomBytes(32).toString("base64url");
  const metadataUrl=CORE+"/.well-known/oauth-protected-resource"+new URL(resource).pathname;
  const metadata=await call(metadataUrl,{method:"GET",headers:{accept:"application/json"}},"MCP metadata");
  const doc=await metadata.json().catch(()=>null);
  ensure(metadata.status===200 && doc?.resource===resource &&
    doc.authorization_servers?.length===1 && doc.authorization_servers[0]===IDENTITY,
    "Production MCP metadata mismatch; stop without mutation");
  // The route is HTTPS and explicitly secret-authenticated. A synthetic token
  // never creates a grant or reads user data. Prove canonical secret matches
  // the live Identity before changing Adapter; don't blindly rotate either.
  const introspection=await call(IDENTITY+"/oauth/introspect",{
    method:"POST",headers:{"content-type":"application/x-www-form-urlencoded","x-lifespace-resource-secret":resourceSecret},
    body:new URLSearchParams({token:fake,resource}),
  },"Identity canonical credential");
  const result=await introspection.json().catch(()=>null);
  ensure(introspection.status===200&&result?.active===false,
    "Canonical protected secret does not authenticate to live Identity; stop without mutation");

  const probe=async()=>{
    const response=await call(resource,{method:"POST",
      headers:{"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+fake},
      body:JSON.stringify({jsonrpc:"2.0",id:"production-mcp-repair-probe",method:"initialize",
        params:{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"synthetic-probe",version:"0.0.0"}}}),
    },"MCP resource authentication");
    const challenge=response.headers.get("www-authenticate")||"";
    if(response.status===401 && /^Bearer\s/u.test(challenge)&&challenge.includes('error="invalid_token"')
      &&challenge.includes('resource_metadata="'+metadataUrl+'"')) return "healthy";
    if(response.status===503) return "unavailable";
    throw new Error("Unexpected MCP authentication response (HTTP "+response.status+"); stop");
  };
  const before=await probe();
  if(before==="healthy") return {ok:true,changed:false,canonicalIdentityAuthenticated:true,
    forgedTokenRejected:true,realUserAuthorizationVerified:false};
  await cf("lifespace-mcp-adapter","secrets",{
    method:"PUT",headers:{"content-type":"application/json"},
    body:JSON.stringify({name:NAME,type:"secret_text",text:resourceSecret}),
  });
  // Wait for the exact public MCP → Core → Adapter → Identity route, not
  // merely secret binding names. A failed probe never counts as successful.
  for(let i=0;i<attempts;i++){
    if(await probe()==="healthy") return {ok:true,changed:true,canonicalIdentityAuthenticated:true,
      forgedTokenRejected:true,realUserAuthorizationVerified:false};
    if(i+1<attempts) await sleep(2000);
  }
  throw new Error("Adapter secret write succeeded but MCP authentication did not converge; do not declare recovery");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await repairProductionMcpResourceSecret({
    accountId:process.env.CLOUDFLARE_ACCOUNT_ID,token:process.env.CLOUDFLARE_API_TOKEN,
    resourceUri:process.env.LIFESPACE_PRODUCTION_MCP_RESOURCE_URI,
    resourceSecret:process.env.LIFESPACE_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET,
    confirmation:process.env.OPERATOR_CONFIRMATION,
  });
  console.log(JSON.stringify(result));
}

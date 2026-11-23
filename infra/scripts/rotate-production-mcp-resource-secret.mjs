// Explicit Owner-only recovery when the previous private OAuth Resource Secret is
// unrecoverable. This is a bounded Identity -> Adapter live-secret cutover, not
// a Core/OAuth code release, Account provisioning, or credential issuance.
// No old secret is available to roll back: rerun with the SAME protected new
// candidate if a partial deployment occurs.
import {randomBytes} from "node:crypto";
import {pathToFileURL} from "node:url";
import {productionResource} from "./repair-production-mcp-resource-secret.mjs";

const IDENTITY="https://auth.aisr.online";
const CORE="https://core.aisr.online";
const WORKERS=["lifespace-identity","lifespace-core","lifespace-mcp-adapter"];
const NAME="OAUTH_RESOURCE_SERVER_SECRET";
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function ensure(ok,message) {if(!ok)throw new Error(message);}

export async function rotateProductionMcpResourceSecret({
  accountId,token,resourceUri,newSecret,confirmation,request=fetch,sleep=pause,attempts=12,
}={}) {
  const resource=productionResource(resourceUri);
  ensure(confirmation==="ROTATE_MCP_RESOURCE_SECRET",
    "Explicit Owner rotation confirmation required");
  ensure(typeof accountId==="string"&&/^[a-f0-9]{32}$/u.test(accountId)
    &&typeof token==="string"&&token.length>=20,"Protected Cloudflare deployment inputs missing");
  // 48 random bytes as base64 (64 characters) are generated offline by the Owner.
  ensure(typeof newSecret==="string"&&/^[A-Za-z0-9+/_=-]{64,512}$/u.test(newSecret),
    "Protected new Resource Secret missing or incorrectly formatted");
  ensure(Number.isInteger(attempts)&&attempts>=1&&attempts<=30,
    "Bounded convergence attempts required");

  const call=async(url,init,label)=>{
    try{return await request(url,{...init,redirect:"manual",signal:AbortSignal.timeout(10000)});}
    catch{throw new Error(label+" request unavailable");}
  };
  const cloudflare=async(worker,suffix,init={})=>{
    const url="https://api.cloudflare.com/client/v4/accounts/"+accountId
      +"/workers/scripts/"+worker+"/"+suffix;
    const response=await call(url,{...init,headers:{authorization:"Bearer "+token,
      accept:"application/json",...(init.headers||{})}},"Cloudflare "+worker);
    const payload=await response.json().catch(()=>null);
    ensure(response.ok&&payload?.success===true,
      "Cloudflare "+worker+" "+suffix+" failed; check partial cutover before retrying");
    return payload.result;
  };
  // Verify all three existing same-environment Workers before any mutation.
  const settings=await Promise.all(WORKERS.map(name=>cloudflare(name,"settings",{method:"GET"})));
  const [identity,core,adapter]=settings.map(s=>s?.bindings);
  const service=(bindings,name,target)=>Array.isArray(bindings)&&bindings.some(b=>
    b.type==="service"&&b.name===name&&b.service===target);
  const secret=bindings=>Array.isArray(bindings)&&bindings.some(b=>
    b.type==="secret_text"&&b.name===NAME);
  ensure(secret(identity)&&secret(adapter)
    &&service(identity,"CORE","lifespace-core")
    &&service(core,"IDENTITY","lifespace-identity")
    &&service(core,"MCP_ADAPTER","lifespace-mcp-adapter")
    &&service(adapter,"IDENTITY","lifespace-identity")
    &&service(adapter,"CORE","lifespace-core"),
    "Production Worker secret/binding inventory does not match reviewed topology");

  const metadataUrl=CORE+"/.well-known/oauth-protected-resource"+new URL(resource).pathname;
  const metadataResponse=await call(metadataUrl,{method:"GET",
    headers:{accept:"application/json"}},"Production MCP metadata");
  const metadata=await metadataResponse.json().catch(()=>null);
  ensure(metadataResponse.status===200&&metadata?.resource===resource
    &&metadata.authorization_servers?.length===1
    &&metadata.authorization_servers[0]===IDENTITY,
    "Expected live Production MCP Resource metadata missing or mismatched");

  // Synthetic bearer has never been issued and is never persisted or printed.
  const fake="lsp_oat_"+randomBytes(32).toString("base64url");
  const inspect=async()=>{
    const response=await call(IDENTITY+"/oauth/introspect",{
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded",
        "x-lifespace-resource-secret":newSecret},
      body:new URLSearchParams({token:fake,resource}),
    },"Identity Resource credential proof");
    const body=await response.json().catch(()=>null);
    if(response.status===200&&body?.active===false)return "accepted";
    if(response.status===401&&body?.error==="invalid_client")return "rejected";
    throw new Error("Unexpected Identity Resource credential response; no further mutation");
  };
  const probe=async()=>{
    const response=await call(resource,{
      method:"POST",headers:{"content-type":"application/json",
        accept:"application/json, text/event-stream",authorization:"Bearer "+fake},
      body:JSON.stringify({jsonrpc:"2.0",id:"mcp-rotation-negative-probe",
        method:"initialize",params:{protocolVersion:"2025-11-25",
          capabilities:{},clientInfo:{name:"rotation-synthetic-probe",version:"0.0.0"}}}),
    },"MCP Resource authentication proof");
    const challenge=response.headers.get("www-authenticate")||"";
    if(response.status===401&&/^Bearer\s/u.test(challenge)
      &&challenge.includes('error="invalid_token"')
      &&challenge.includes('resource_metadata="'+metadataUrl+'"'))return "healthy";
    if(response.status===503)return "unavailable";
    throw new Error("Unexpected MCP Resource response (HTTP "+response.status+"); no further mutation");
  };
  const candidate=await inspect();
  const before=await probe();
  if(candidate==="accepted"&&before==="healthy")
    return {ok:true,changed:false,identityAccepted:true,forgedBearerRejected:true,
      realUserAuthorizationVerified:false};

  // Deliberate brief outage window. Updating only the named secret never
  // reinitializes Account, revokes OAuth user tokens, or changes Core authority.
  let identityUpdated=false;
  if(candidate==="rejected"){
    await cloudflare("lifespace-identity","secrets",{method:"PUT",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({name:NAME,type:"secret_text",text:newSecret})});
    identityUpdated=true;
  }
  let accepted=candidate==="accepted";
  for(let i=0;!accepted&&i<attempts;i++){
    if(i>0)await sleep(2000);
    try{accepted=(await inspect())==="accepted";}
    catch{if(i===attempts-1)throw new Error(
      "Identity updated but verification unavailable; rerun using SAME protected candidate");}
  }
  ensure(accepted,"Identity not yet accepting new Secret; Adapter remains unchanged. "
    +"Rerun SAME protected candidate after checking live Identity");

  await cloudflare("lifespace-mcp-adapter","secrets",{method:"PUT",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({name:NAME,type:"secret_text",text:newSecret})});
  for(let i=0;i<attempts;i++){
    if(i>0)await sleep(2000);
    if(await probe()==="healthy")
      return {ok:true,changed:true,identityUpdated,adapterUpdated:true,
        identityAccepted:true,forgedBearerRejected:true,realUserAuthorizationVerified:false};
  }
  throw new Error("Private Adapter updated but live MCP authentication did not converge. "
    +"Keep the SAME protected candidate and rerun after diagnosis");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const result=await rotateProductionMcpResourceSecret({
    accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    token:process.env.CLOUDFLARE_API_TOKEN,
    resourceUri:process.env.LIFESPACE_PRODUCTION_MCP_RESOURCE_URI,
    newSecret:process.env.LIFESPACE_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET,
    confirmation:process.env.OPERATOR_CONFIRMATION,
  });
  console.log(JSON.stringify(result));
}

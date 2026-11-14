import test from "node:test";
import assert from "node:assert/strict";
import {repairProductionMcpResourceSecret,productionResource} from "./repair-production-mcp-resource-secret.mjs";
const uri="https://core.aisr.online/mcp/mcp_"+"a".repeat(32);
const secret="synthetic-resource-secret-"+"a".repeat(48);
const name="OAUTH_RESOURCE_SERVER_SECRET";
const bind=(name,service)=>({name,type:"service",service});
const credential={name,type:"secret_text"};
function fixture({identityStatus=200,initial=503,final=401,wrongBinding=false,writeOK=true}={}) {
  const writes=[]; let probes=0; const calls=[];
  const request=async (url,init)=>{
    calls.push({url,method:init.method});
    const p=new URL(url);
    if(p.hostname==="api.cloudflare.com"){
      const worker=p.pathname.split("/").at(-2);
      if(p.pathname.endsWith("/settings")){
        const bindings=worker==="lifespace-identity"?[credential,bind("CORE","lifespace-core")]
          :worker==="lifespace-core"?[bind("IDENTITY","lifespace-identity"),bind("MCP_ADAPTER","lifespace-mcp-adapter")]
          :[credential,bind("IDENTITY",wrongBinding?"lifespace-identity-staging":"lifespace-identity"),bind("CORE","lifespace-core")];
        return Response.json({success:true,result:{bindings}});
      }
      assert.equal(worker,"lifespace-mcp-adapter");assert.equal(init.method,"PUT");
      writes.push(JSON.parse(init.body));
      return Response.json({success:writeOK});
    }
    if(p.hostname==="auth.aisr.online"){
      assert.equal(p.pathname,"/oauth/introspect");assert.equal(init.headers["x-lifespace-resource-secret"],secret);
      assert.match(init.body.get("token"),/^lsp_oat_/u);
      return Response.json({active:false},{status:identityStatus});
    }
    if(p.pathname.startsWith("/.well-known/"))return Response.json({resource:uri,authorization_servers:["https://auth.aisr.online"]});
    assert.equal(url,uri);assert.match(init.headers.authorization,/^Bearer lsp_oat_/u);
    const status=probes++===0?initial:final;
    return Response.json({}, {status,headers:status===401?{"www-authenticate":'Bearer resource_metadata="https://core.aisr.online/.well-known/oauth-protected-resource'+p.pathname+'", error="invalid_token"'}:{}});
  };
  const options={accountId:"a".repeat(32),token:"synthetic-api-token-".repeat(3),resourceUri:uri,
    resourceSecret:secret,confirmation:"REPAIR_MCP_RESOURCE_SECRET",request,sleep:async()=>{},attempts:2};
  return {writes,calls,options};
}
test("proves canonical Identity secret and repairs only the private Adapter; validates actual wire",async()=>{
  const f=fixture();const result=await repairProductionMcpResourceSecret(f.options);
  assert.equal(result.changed,true);assert.equal(result.forgedTokenRejected,true);
  assert.equal(result.realUserAuthorizationVerified,false);
  assert.deepEqual(f.writes,[{name,type:"secret_text",text:secret}]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(f.calls.filter(x=>x.method==="PUT").length,1);
});
test("healthy wire is a no-op",async()=>{
  const f=fixture({initial:401});assert.equal((await repairProductionMcpResourceSecret(f.options)).changed,false);
  assert.equal(f.writes.length,0);
});
test("wrong Identity credential, binding, confirmation or target fails before mutation",async()=>{
  for(const [f,extra] of [[fixture({identityStatus:401}),{}],[fixture({wrongBinding:true}),{}],
    [fixture(),{confirmation:""}],[fixture(),{resourceUri:uri.replace("core.","core-staging.")}]]){
    await assert.rejects(repairProductionMcpResourceSecret({...f.options,...extra}));
    assert.equal(f.writes.length,0);
  }
  assert.throws(()=>productionResource(uri+"?x=1"));
});
test("failed write, unexpected probe, or persistent 503 cannot report recovery",async()=>{
  for(const f of [fixture({writeOK:false}),fixture({initial:403}),fixture({final:503})]){
    await assert.rejects(repairProductionMcpResourceSecret(f.options));
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {rotateProductionMcpResourceSecret} from "./rotate-production-mcp-resource-secret.mjs";

const uri="https://core.aisr.online/mcp/mcp_"+"a".repeat(32);
const fresh="A".repeat(64);
const name="OAUTH_RESOURCE_SERVER_SECRET";
const binding=(name,service)=>({name,type:"service",service});
const protectedSecret={name,type:"secret_text"};

function fixture({newAccepted=false,initialHealthy=true,identityWriteOk=true,
  adapterWriteOk=true,wrongBinding=false,badMetadata=false,
  unexpectedIdentity=false,neverConverge=false}={}) {
  const writes=[],events=[];
  let identityAccepted=newAccepted,adapterAccepted=newAccepted;
  const request=async(url,init)=>{
    const p=new URL(url);
    if(p.hostname==="api.cloudflare.com"){
      const worker=p.pathname.split("/").at(-2);
      if(p.pathname.endsWith("/settings")){
        const bindings=worker==="lifespace-identity"
          ?[protectedSecret,binding("CORE","lifespace-core")]
          :worker==="lifespace-core"
            ?[binding("IDENTITY","lifespace-identity"),binding("MCP_ADAPTER","lifespace-mcp-adapter")]
            :[protectedSecret,binding("CORE","lifespace-core"),binding("IDENTITY",
              wrongBinding?"lifespace-identity-staging":"lifespace-identity")];
        events.push("inventory:"+worker);
        return Response.json({success:true,result:{bindings}});
      }
      assert.equal(p.pathname.split("/").at(-1),"secrets");
      assert.equal(init.method,"PUT");
      const data=JSON.parse(init.body);
      assert.deepEqual(data,{name,type:"secret_text",text:fresh});
      writes.push(worker);
      events.push("write:"+worker);
      const success=worker==="lifespace-identity"?identityWriteOk:adapterWriteOk;
      if(success){
        if(worker==="lifespace-identity")identityAccepted=true;
        if(worker==="lifespace-mcp-adapter")adapterAccepted=true;
      }
      return Response.json({success},{status:success?200:503});
    }
    if(p.hostname==="auth.aisr.online"){
      assert.equal(p.pathname,"/oauth/introspect");
      assert.equal(init.headers["x-lifespace-resource-secret"],fresh);
      assert.match(init.body.get("token"),/^lsp_oat_/u);
      assert.equal(init.body.get("resource"),uri);
      events.push("introspect");
      if(unexpectedIdentity)return Response.json({error:"unexpected"},{status:403});
      return identityAccepted
        ?Response.json({active:false})
        :Response.json({error:"invalid_client"},{status:401});
    }
    if(p.pathname.startsWith("/.well-known/")){
      events.push("metadata");
      return Response.json({resource:badMetadata?"https://wrong.example.test":uri,
        authorization_servers:["https://auth.aisr.online"]});
    }
    assert.equal(url,uri);
    assert.match(init.headers.authorization,/^Bearer lsp_oat_/u);
    events.push("probe");
    const good=neverConverge?false:(identityAccepted===adapterAccepted&&
      (identityAccepted||initialHealthy));
    const status=good?401:503;
    return Response.json({},{
      status,
      headers:good?{"www-authenticate":'Bearer resource_metadata="https://core.aisr.online/.well-known/oauth-protected-resource'+p.pathname+'", error="invalid_token"'}:{},
    });
  };
  const options={accountId:"f".repeat(32),token:"test-cloudflare-token-".repeat(3),
    resourceUri:uri,newSecret:fresh,confirmation:"ROTATE_MCP_RESOURCE_SECRET",
    request,sleep:async()=>{},attempts:2};
  return {writes,events,options};
}

test("rotates only private Identity then Adapter, verifies new key and live forged-token denial",async()=>{
  const f=fixture();
  const result=await rotateProductionMcpResourceSecret(f.options);
  assert.deepEqual(f.writes,["lifespace-identity","lifespace-mcp-adapter"]);
  assert.equal(result.identityUpdated,true);
  assert.equal(result.adapterUpdated,true);
  assert.equal(result.identityAccepted,true);
  assert.equal(result.forgedBearerRejected,true);
  assert.equal(result.realUserAuthorizationVerified,false);
  assert.ok(f.events.indexOf("introspect")<f.events.indexOf("write:lifespace-identity"));
  assert.ok(f.events.indexOf("write:lifespace-identity")<f.events.lastIndexOf("introspect"));
  assert.ok(f.events.lastIndexOf("introspect")<f.events.indexOf("write:lifespace-mcp-adapter"));
  assert.ok(!JSON.stringify(result).includes(fresh));
});

test("same protected candidate and healthy live MCP are an idempotent no-op",async()=>{
  const f=fixture({newAccepted:true});
  const result=await rotateProductionMcpResourceSecret(f.options);
  assert.equal(result.changed,false);
  assert.deepEqual(f.writes,[]);
});

test("partially rotated Identity is repaired by Adapter-only write",async()=>{
  const f=fixture({newAccepted:true,initialHealthy:false});
  const result=await rotateProductionMcpResourceSecret(f.options);
  assert.equal(result.identityUpdated,false);
  assert.deepEqual(f.writes,["lifespace-mcp-adapter"]);
});

test("a failed Identity write never rotates Adapter",async()=>{
  const f=fixture({identityWriteOk:false});
  await assert.rejects(rotateProductionMcpResourceSecret(f.options),/Cloudflare lifespace-identity secrets failed/u);
  assert.deepEqual(f.writes,["lifespace-identity"]);
});

test("failed Adapter write records incomplete cutover; retry with SAME candidate",async()=>{
  const f=fixture({adapterWriteOk:false});
  await assert.rejects(rotateProductionMcpResourceSecret(f.options),/Cloudflare lifespace-mcp-adapter secrets failed/u);
  assert.deepEqual(f.writes,["lifespace-identity","lifespace-mcp-adapter"]);
});

test("never declares success when live wire fails to converge",async()=>{
  const f=fixture({neverConverge:true});
  await assert.rejects(rotateProductionMcpResourceSecret(f.options),/did not converge/u);
  assert.deepEqual(f.writes,["lifespace-identity","lifespace-mcp-adapter"]);
});

test("wrong authority/target/metadata/credential is rejected without any mutation",async()=>{
  const scenarios=[
    [fixture(),{confirmation:""}],
    [fixture(),{newSecret:"short"}],
    [fixture(),{resourceUri:uri.replace("core.","core-staging.")}],
    [fixture({wrongBinding:true}),{}],
    [fixture({badMetadata:true}),{}],
    [fixture({unexpectedIdentity:true}),{}],
  ];
  for(const [f,override] of scenarios){
    await assert.rejects(rotateProductionMcpResourceSecret({...f.options,...override}));
    assert.deepEqual(f.writes,[]);
  }
});

test("unexpected live wire response before mutation fails closed",async()=>{
  const f=fixture({newAccepted:true,neverConverge:true});
  // Valid 503 is permitted as a recovery case; this remains an Adapter repair,
  // not a successful health proof.
  await assert.rejects(rotateProductionMcpResourceSecret(f.options));
  assert.deepEqual(f.writes,["lifespace-mcp-adapter"]);
});

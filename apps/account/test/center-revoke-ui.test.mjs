import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const code=readFileSync(new URL("../public/center.js",import.meta.url),"utf8");
const ID="oaz_"+"a".repeat(32);

function node() {
  const events=new Map();
  return {
    textContent:"",hidden:false,disabled:false,children:[],dataset:{},
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},
    append(...children){this.children.push(...children);},
    replaceChildren(...children){this.children=[...children];},
    setAttribute(){},removeAttribute(){},
    addEventListener(type,fn){events.set(type,fn);},
    showModal(){this.open=true;},close(){this.open=false;},
  };
}

test("successful OAuth revoke cannot be misreported as a refreshed list if the follow-up read fails",async()=>{
  const nodes=new Map();
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,node());
    return nodes.get(id);
  };
  let revoked=false;
  const fetch=async (url)=>{
    if(url==="/api/session")return Response.json({data:{user:{
      id:"usr_test",displayName:"Test",avatarUrl:null},csrfToken:"test-csrf"}});
    if(url==="/api/account/login-email")return Response.json({data:{
      email:null,status:"unlinked",linked:false}});
    if(url.startsWith("/api/account/authorizations?offset=")){
      if(revoked)return Response.json({error:{message:"Upstream unavailable"}},{status:503});
      return Response.json({data:{items:[{
        id:ID,clientName:"Test Client",clientId:"client_test",status:"active",
        applicationId:"app_test",spaceId:"spc_test",agentId:"agt_test",resource:"https://mcp.example.test",
        scopes:["resources:read"],allowUserAuthorization:false,createdAt:"2026-11-10T00:00:00Z",revokedAt:null,
      }],nextOffset:null}});
    }
    if(url==="/api/account/authorizations/"+ID+"/revoke"){
      revoked=true;
      return Response.json({data:{id:ID,revoked:true}});
    }
    throw Error("Unexpected UI request "+url);
  };
  const sandbox={
    document:{getElementById:element,createElement:()=>node(),querySelectorAll:()=>[]},
    location:{hash:"#account"},window:{addEventListener(){}},fetch,Response,
  };
  // Evaluate once. The callback is invoked against the same deterministic DOM
  // snapshot used by the UI controller, with no browser/network side effects.
  const exposed=runInNewContext(code+"\n;({state,revoke})",sandbox);
  exposed.state.csrf="test-csrf";
  exposed.state.revokeId=ID;
  exposed.state.revokeKind="oauth";
  await exposed.revoke();
  assert.equal(revoked,true);
  assert.match(element("oauth-message").textContent,/已撤销，但列表刷新失败/u);
  assert.equal(element("oauth-message").hidden,false);
  assert.equal(element("oauth-items").children.length,0);
  assert.equal(exposed.state.revokeBusy,false);
});

test("OAuth cards identify individual grants and never duplicate the revoked badge",()=>{
  const nodes=new Map();
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,node());
    return nodes.get(id);
  };
  const sandbox={
    document:{getElementById:element,createElement:()=>node(),querySelectorAll:()=>[]},
    location:{hash:"#account"},window:{addEventListener(){}},Response,
  };
  const exposed=runInNewContext(code+"\n;({state,authorizationRow,openRevoke})",sandbox);
  const item={
    id:ID,clientName:"Test Client",clientId:"client_test",status:"active",
    applicationId:"app_test",spaceId:"spc_test",agentId:"agt_test",
    resource:"https://mcp.example.test",scopes:["resources:read"],
    allowUserAuthorization:true,createdAt:"2026-11-10T00:00:00Z",revokedAt:null,
  };
  const descendants=element=>[element,...element.children.flatMap(descendants)];
  const active=descendants(exposed.authorizationRow(item));
  assert.equal(active.filter(n=>n.textContent==="断开此授权").length,1);
  assert.equal(active.filter(n=>n.textContent==="未撤销").length,1);
  assert.equal(active.filter(n=>n.textContent?.includes("授权于 ")).length,1);

  const revoked=descendants(exposed.authorizationRow({
    ...item,status:"revoked",revokedAt:"2026-11-10T01:00:00Z",
  }));
  assert.equal(revoked.filter(n=>n.textContent==="已撤销").length,1);
  assert.equal(revoked.filter(n=>n.textContent==="断开此授权").length,0);

  exposed.state.csrf="test-csrf";
  exposed.openRevoke(item,"oauth");
  assert.equal(element("revoke-heading").textContent,"断开应用授权");
  assert.match(element("revoke-detail").textContent,new RegExp(ID.slice(-8)));
  assert.match(element("revoke-detail").textContent,/其他授权不会受影响/u);
  assert.equal(element("revoke-dialog").open,true);
});

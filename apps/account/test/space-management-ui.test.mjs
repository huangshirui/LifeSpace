import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const source=readFileSync(new URL("../public/center.js",import.meta.url),"utf8");
const A="spc_"+"a".repeat(32),B="spc_"+"b".repeat(32),USER="usr_test";
const info={id:A,name:"Space A",timezone:"UTC",version:2,access:"owner"};
const member={userId:"usr_child",displayName:"Child",role:"editor",version:3};
const token="LS-ABCD-EFGH-JKLM-NPQR";
const invite={id:"inv_"+"c".repeat(32),tokenPrefix:"LS-ABCD",role:"editor",status:"active",usedCount:0,maxUses:1,expiresAt:"2026-11-18T00:00:00Z"};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function node(tag="div"){
  return {tag,textContent:"",value:"",children:[],hidden:false,disabled:false,dataset:{},events:new Map(),
    classList:{add(){},remove(){},toggle(){},contains(){return false;}},
    append(...children){this.children.push(...children);},
    replaceChildren(...children){this.children=children;},
    setAttribute(){},removeAttribute(){},addEventListener(type,fn){this.events.set(type,fn);},
    querySelectorAll(){return [];},showModal(){this.open=true;},close(){this.open=false;},
  };
}
function contains(node,text){return node.textContent.includes(text)||node.children.some(child=>contains(child,text));}
async function fixture(hash,access="owner",holdInvites=false){
  const nodes=new Map(),requests=[],location={hash};
  let releaseInvites;
  const element=id=>{if(!nodes.has(id))nodes.set(id,node());return nodes.get(id);};
  const fetch=async (url,options={})=>{
    requests.push({url,options});
    if(url==="/api/session?include=login-email")return Response.json({data:{user:{id:USER,displayName:"Test",avatarUrl:null},csrfToken:"test-csrf",loginEmail:{email:null,status:"unlinked",version:0}}});
    if(url==="/api/account/spaces")return Response.json({data:[{id:A,name:"Space A",role:access},{id:B,name:"Space B",role:"owner"}]});
    const base="/api/account/spaces/"+A;
    if(url===base)return Response.json({data:{...info,access}});
    if(url===base+"/members")return Response.json({data:[member]});
    if(url===base+"/invites"){
      if(holdInvites){holdInvites=false;return new Promise(resolve=>{releaseInvites=()=>resolve(Response.json({data:[invite]}));});}
      return Response.json({data:[invite]});
    }
    if(url===base+"/invites/create")return Response.json({data:{...invite,token}},{status:201});
    throw Error("Unexpected request "+url);
  };
  const window={addEventListener(){},history:{replaceState(_state,_title,hash){location.hash=hash;}}};
  const exposed=runInNewContext(source+"\n;({state,loadSpaces,selectSpacePage,navigate,openSpaceOperation})",{
    document:{getElementById:element,createElement:node,querySelectorAll:()=>[]},
    window,location,fetch,Response,URL,
  });
  await flush();await flush();
  return {element,requests,exposed,location,releaseInvites:()=>releaseInvites?.()};
}
test("Deep-linked invitation tab loads only selected Space and invites, member and settings tabs are real views",async()=>{
  const t=await fixture("#spaces/"+A+"/invites");
  assert.equal(t.exposed.state.space,A);
  assert.ok(t.requests.some(r=>r.url.endsWith("/invites")));
  assert.ok(!t.requests.some(r=>r.url.endsWith("/members")));
  assert.ok(contains(t.element("space-detail"),"创建邀请"));
  t.exposed.selectSpacePage(A,"members");await flush();
  assert.ok(contains(t.element("space-detail"),"Child"));
  assert.ok(contains(t.element("space-detail"),"调整角色"));
  t.exposed.selectSpacePage(A,"settings");await flush();
  assert.ok(contains(t.element("space-detail"),"注销空间"));
  assert.equal(t.location.hash,"#spaces/"+A+"/settings");
});
test("Unavailable deep link does not silently select a different Space",async()=>{
  const t=await fixture("#spaces/spc_missing/settings");
  assert.equal(t.exposed.state.space,null);
  assert.ok(contains(t.element("space-detail"),"当前不可访问"));
  assert.ok(!t.requests.some(r=>r.url.startsWith("/api/account/spaces/")));
});
test("Viewer cannot load invitations even from direct hash, and never sees owner close",async()=>{
  const t=await fixture("#spaces/"+A+"/invites","viewer");
  assert.ok(!t.requests.some(r=>r.url.endsWith("/invites")));
  assert.ok(contains(t.element("space-detail"),"不能管理邀请"));
  t.exposed.selectSpacePage(A,"settings");await flush();
  assert.ok(contains(t.element("space-detail"),"退出空间"));
  assert.ok(!contains(t.element("space-detail"),"注销空间"));
});
test("Stale invitation response cannot append into a newer settings view",async()=>{
  const t=await fixture("#spaces/"+A+"/invites","owner",true);
  t.exposed.selectSpacePage(A,"settings");await flush();
  t.releaseInvites();await flush();
  assert.ok(contains(t.element("space-detail"),"注销空间"));
  assert.ok(!contains(t.element("space-detail"),"LS-ABCD"));
});
test("Invitation plaintext stays in the one-time dialog and is cleared on close",async()=>{
  const t=await fixture("#spaces/"+A+"/invites");
  t.exposed.openSpaceOperation(info,"invite-create");
  const form=t.element("space-operation-form");
  await form.onsubmit({preventDefault(){}});
  assert.equal(t.element("space-operation-code").value,token);
  const mutation=t.requests.find(r=>r.url.endsWith("/invites/create"));
  assert.deepEqual(JSON.parse(mutation.options.body),{confirmSpaceId:A,intent:"create-space-invite",role:"editor",expiresInMinutes:1440,maxUses:1});
  t.element("space-operation-cancel").onclick();
  assert.equal(t.element("space-operation-code").value,"");
  assert.equal(t.element("space-operation-dialog").open,false);
  assert.ok(!contains(t.element("space-detail"),token));
});

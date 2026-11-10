import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const html=readFileSync(new URL("../public/center.html",import.meta.url),"utf8");
const js=readFileSync(new URL("../public/center.js",import.meta.url),"utf8");

function harness(){
  const nodes=new Map(),calls=[],navigations=[],prompts=[];
  let consent=false;
  function node(){
    const events=new Map();
    return {
      textContent:"",value:"",hidden:false,disabled:false,readOnly:false,
      children:[],dataset:{},events,
      classList:{add(){},remove(){},toggle(){},contains(){return false;}},
      append(...items){this.children.push(...items);},
      replaceChildren(...items){this.children=[...items];},
      addEventListener(kind,handler){events.set(kind,handler);},
      focus(){this.focused=true;},setAttribute(){},removeAttribute(){},
      showModal(){this.open=true;},close(){this.open=false;},
    };
  }
  const element=id=>{
    if(!nodes.has(id))nodes.set(id,node());
    return nodes.get(id);
  };
  const sandbox={
    document:{getElementById:element,createElement:()=>node(),querySelectorAll:()=>[],title:"账户中心"},
    location:{hash:"#account"},
    window:{addEventListener(){},confirm(message){prompts.push(message);return consent;},
      location:{assign(url){navigations.push(url);}}},
    fetch:async(url,opts)=>{
      if(url==="/api/session")return new Promise(()=>{}); // prevent the initial GET from racing with the test
      calls.push({url,opts});
      if(url==="/api/account/profile"){
        const body=JSON.parse(opts.body);
        return Response.json({data:{id:"usr_test",displayName:body.displayName}});
      }
      if(url==="/api/account/login-email/change"){
        const body=JSON.parse(opts.body);
        return Response.json({data:{email:body.email,status:"pending",linked:false,version:3}});
      }
      throw Error("Unexpected mock URL: "+url);
    },
    Response,
    Date,
  };
  const exposed=runInNewContext(js+"\n;({state,setProfileEdit})",sandbox);
  exposed.state.csrf="csrf-test";
  exposed.state.user={id:"usr_test",displayName:"Original",avatarUrl:null};
  exposed.state.emailVersion=2;
  exposed.state.emailValue="old@example.test";
  element("name-input").value="Original";element("name-input").readOnly=true;
  element("email-input").value="old@example.test";element("email-input").readOnly=true;
  element("profile-email").textContent="old@example.test";
  return {element,exposed,calls,navigations,prompts,setConsent(value){consent=value;},
    async fire(id,event,properties={}){const fn=element(id).events.get(event);
      assert.equal(typeof fn,"function","listener "+event+" missing on "+id);
      return fn({preventDefault(){},...properties});
    }};
}

test("Name/email are read-only by default and have distinct edit, save and cancel buttons",()=>{
  for(const id of ["name","email"]){
    assert.match(html,new RegExp('id="'+id+'-input"[^>]*\\breadonly\\b'));
    assert.match(html,new RegExp('id="'+id+'-edit"[^>]*disabled'));
    assert.match(html,new RegExp('id="'+id+'-cancel"[^>]*hidden'));
    assert.match(html,new RegExp('id="'+id+'-save"[^>]*hidden'));
  }
  assert.match(html,/id="logout"[^>]*type="button"/u);
  assert.match(html,/href="#i-log-out"/u);
});
test("Editing is explicit and cancel restores original values without requests",async()=>{
  const t=harness();
  await t.fire("name-edit","click");
  assert.equal(t.element("name-input").readOnly,false);
  assert.equal(t.element("name-input").focused,true);
  assert.equal(t.element("name-edit").hidden,true);
  assert.equal(t.element("name-save").hidden,false);
  t.element("name-input").value="Accidental";
  await t.fire("name-cancel","click");
  assert.equal(t.element("name-input").value,"Original");
  assert.equal(t.element("name-input").readOnly,true);
  assert.equal(t.element("name-edit").hidden,false);
  assert.equal(t.element("name-save").hidden,true);

  await t.fire("email-edit","click");
  t.element("email-input").value="wrong@example.test";
  await t.fire("email-cancel","click");
  assert.equal(t.element("email-input").value,"old@example.test");
  assert.equal(t.element("email-input").readOnly,true);
  assert.equal(t.calls.length,0);
});
test("Direct submit without edit does not mutate, successful save restores read-only",async()=>{
  const t=harness();
  await t.fire("profile-form","submit");
  await t.fire("email-form","submit");
  assert.equal(t.calls.length,0);

  await t.fire("name-edit","click");
  t.element("name-input").value="Corrected";
  await t.fire("profile-form","submit");
  assert.equal(t.calls.length,1);
  assert.equal(t.calls[0].url,"/api/account/profile");
  assert.equal(t.element("name-input").value,"Corrected");
  assert.equal(t.element("name-input").readOnly,true);
  assert.equal(t.element("name-save").hidden,true);

  await t.fire("email-edit","click");
  t.element("email-input").value="new@example.test";
  await t.fire("email-form","submit");
  assert.equal(t.calls.length,1,"email must require a second explicit confirmation");
  assert.equal(t.element("email-input").readOnly,false);
  t.setConsent(true);
  await t.fire("email-form","submit");
  assert.equal(t.calls.length,2);
  assert.equal(t.calls[1].url,"/api/account/login-email/change");
  assert.equal(t.element("email-input").readOnly,true);
  assert.equal(t.element("email-input").value,"new@example.test");
  assert.equal(t.exposed.state.emailVersion,3);
  assert.equal(t.element("email-status").textContent,"等待新邮箱验证");
});
test("Logout requires consent and navigates only to the current host's Cloudflare Access endpoint",async()=>{
  const t=harness();
  await t.fire("logout","click");
  assert.equal(t.navigations.length,0);
  assert.match(t.prompts[0],/Cloudflare Access/u);
  assert.match(t.prompts[0],/其他/u);
  assert.match(t.prompts[0],/OAuth/u);
  t.setConsent(true);
  await t.fire("logout","click");
  assert.deepEqual(t.navigations,["/cdn-cgi/access/logout"]);
  assert.equal(t.exposed.state.csrf,null);
  assert.equal(t.calls.length,0);
});

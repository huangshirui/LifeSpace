const $=id=>document.getElementById(id);
let csrf="",offset=0,busy=false;
const show=(id,flag)=>$(id).classList.toggle("hidden",!flag);
async function call(path,options={}){
  const response=await fetch(path,{...options,credentials:"same-origin",headers:{accept:"application/json",...(options.headers||{})}});
  const payload=await response.json().catch(()=>null);
  if(!response.ok||!payload?.data)throw new Error(payload?.error?.message||"请求失败");
  return payload.data;
}
function error(message){
  show("loading",false);show("error",true);$("error-message").textContent=message;
}
function line(title,value){
  const p=document.createElement("p");p.className="subline";
  const label=document.createElement("span");label.textContent=title;
  const content=document.createElement("span");content.textContent=String(value);
  p.append(label,content);return p;
}
async function revoke(item,button){
  if(busy||!csrf)return;
  if(!confirm("确认撤销 "+item.modelKey+" · "+item.operation+" 的 Agent 委托？\\n撤销后无法恢复，已发生的修改不会自动回滚。"))return;
  busy=true;button.disabled=true;
  try{
    await call("/api/delegations/revoke",{method:"POST",headers:{"content-type":"application/json","x-lifespace-csrf":csrf},
      body:JSON.stringify({intent:"revoke-user-delegation",delegationId:item.id})});
    button.parentElement?.remove();
    if(!$("items").children.length)show("empty",true);
  }catch(e){alert(e.message||"无法撤销委托");button.disabled=false;}
  finally{busy=false;}
}
function render(item){
  const article=document.createElement("article");article.className="card";
  const title=document.createElement("h3");title.textContent=item.modelKey+" · "+item.operation;
  article.append(title,line("Agent",item.agentId),line("Application",item.applicationId),
    line("Space",item.spaceId),line("授权方式",item.mode==="once"?"一次性":item.mode==="timed"?"限时可重复":"长期直到撤销"),
    line("创建时间",new Date(item.createdAt).toLocaleString()),
    line("到期时间",item.expiresAt?new Date(item.expiresAt).toLocaleString():"不会自动到期"));
  const button=document.createElement("button");button.type="button";button.className="ghost";
  button.textContent="撤销这项授权";button.addEventListener("click",()=>revoke(item,button));
  article.append(button);$("items").append(article);
}
async function load(reset=false){
  if(reset){offset=0;$("items").replaceChildren();show("empty",false);}
  show("loading",true);show("error",false);show("more",false);
  try{
    const page=await call("/api/delegations?offset="+offset);
    page.items.forEach(render);
    offset=page.nextOffset??0;
    show("more",page.nextOffset!==null);
    show("empty",!$("items").children.length);
    show("loading",false);show("content",true);
  }catch(e){error(e.message||"无法读取授权列表");}
}
async function init(){
  try{csrf=(await call("/api/session")).csrfToken;if(!csrf)throw Error("无法验证登录会话");
    await load(true);
  }catch(e){error(e.message||"请重新登录");}
}
$("retry").addEventListener("click",init);
$("more").addEventListener("click",()=>load(false));
init();

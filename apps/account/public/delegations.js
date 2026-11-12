const $=id=>document.getElementById(id);
let csrf="",offset=0,busy=false,pending=null;
const show=(id,flag)=>$(id).classList.toggle("hidden",!flag);
const modelNames={person:"人物",activity:"活动",anniversary:"纪念日",day_record:"日记录",health_assessment:"健康评估"};
const operationNames={query:"查询",get:"查看",create:"新增",update:"修改",delete:"删除"};
const displayTitle=item=>(modelNames[item.modelKey]||item.modelKey)+" · "+(operationNames[item.operation]||item.operation);
const localTime=value=>new Date(value).toLocaleString("zh-CN");
function clientLabel(clientId){
  try {
    const url=new URL(clientId);
    if(url.protocol==="https:")return url.hostname;
  }catch {}
  return "第三方 OAuth 客户端";
}
function lifetime(item){
  if(item.mode==="once")return "一次性授权";
  if(item.mode==="timed")return "限时授权"+(item.expiresAt?" · 至 "+localTime(item.expiresAt):"");
  return "长期授权 · 直到撤销";
}
async function call(path,options={}){
  const response=await fetch(path,{...options,credentials:"same-origin",headers:{accept:"application/json",...(options.headers||{})}});
  const payload=await response.json().catch(()=>null);
  if(!response.ok||!payload?.data)throw new Error(payload?.error?.message||"请求失败");
  return payload.data;
}
function error(message){
  show("loading",false);show("error",true);$("error-message").textContent=message;
}
function detail(label,value){
  const row=document.createElement("div");row.className="delegation-detail-row";
  const dt=document.createElement("dt");dt.textContent=label;
  const dd=document.createElement("dd");dd.textContent=String(value);
  row.append(dt,dd);return row;
}
function confirmRevoke(item,article){
  if(busy||!csrf)return;
  pending={item,article};
  $("revoke-title").textContent="撤销「"+displayTitle(item)+"」授权？";
  $("revoke-message").textContent="撤销后，该 Agent 将无法继续使用此项委托。已完成的操作不会自动撤回。";
  $("revoke-error").textContent="";
  show("revoke-error",false);
  $("revoke-dialog").showModal();
}
async function revoke(){
  if(busy||!pending||!csrf)return;
  const {item,article}=pending;
  busy=true;
  $("revoke-confirm").disabled=true;
  $("revoke-cancel").disabled=true;
  try{
    await call("/api/delegations/revoke",{method:"POST",headers:{"content-type":"application/json","x-lifespace-csrf":csrf},
      body:JSON.stringify({intent:"revoke-user-delegation",delegationId:item.id})});
    article.remove();
    show("empty",!$("items").children.length);
    $("feedback").textContent="已撤销「"+displayTitle(item)+"」授权，后续操作将被拒绝。";
    show("feedback",true);
    pending=null;
    $("revoke-dialog").close();
  }catch(e){
    $("revoke-error").textContent=e.message||"撤销失败，请重试";
    show("revoke-error",true);
  }finally{
    busy=false;
    $("revoke-confirm").disabled=false;
    $("revoke-cancel").disabled=false;
  }
}
function render(item){
  const article=document.createElement("article");article.className="delegation-item";
  const head=document.createElement("div");head.className="delegation-item-head";
  const identity=document.createElement("div");identity.className="delegation-item-identity";
  const title=document.createElement("h3");title.textContent=displayTitle(item);
  const info=document.createElement("p");info.className="delegation-client";
  info.textContent="OAuth 客户端标识："+clientLabel(item.clientId);
  identity.append(title,info);
  const revokeButton=document.createElement("button");revokeButton.type="button";
  revokeButton.className="ghost delegation-revoke";revokeButton.textContent="撤销授权";
  revokeButton.addEventListener("click",()=>confirmRevoke(item,article));
  head.append(identity,revokeButton);
  const meta=document.createElement("p");meta.className="delegation-meta";
  const mode=document.createElement("strong");mode.textContent=lifetime(item);
  const created=document.createElement("span");created.textContent="批准于 "+localTime(item.createdAt);
  meta.append(mode,created);
  const technical=document.createElement("details");technical.className="delegation-details";
  const summary=document.createElement("summary");summary.textContent="查看技术信息";
  const entries=document.createElement("dl");entries.className="delegation-detail-list";
  entries.append(detail("Client ID",item.clientId),detail("MCP Resource",item.resource),
    detail("Agent",item.agentId),detail("Application",item.applicationId),
    detail("Space",item.spaceId),detail("Model / Operation",item.modelKey+" / "+item.operation),
    detail("到期时间",item.expiresAt?localTime(item.expiresAt):"不自动到期"));
  technical.append(summary,entries);
  article.append(head,meta,technical);
  $("items").append(article);
}
async function load(reset=false){
  if(reset){offset=0;$("items").replaceChildren();show("empty",false);show("feedback",false);}
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
$("revoke-confirm").addEventListener("click",revoke);
$("revoke-cancel").addEventListener("click",()=>{if(!busy){pending=null;$("revoke-dialog").close();}});
$("revoke-dialog").addEventListener("cancel",event=>{if(busy)event.preventDefault();else pending=null;});
$("retry").addEventListener("click",init);
$("more").addEventListener("click",()=>load(false));
init();

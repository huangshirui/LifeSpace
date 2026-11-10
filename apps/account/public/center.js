const $ = id => document.getElementById(id);
const PANELS = new Set(["account","spaces","connections","audit"]);
const TABS = new Set(["oauth","delegations","direct","event","external"]);
const roles = {owner:"所有者",admin:"管理员",editor:"编辑者",viewer:"查看者"};
const opNames = {query:"查询",get:"查看",create:"新增",update:"修改",delete:"删除"};
const state = {user:null,csrf:null,spaces:[],space:null,auditLoaded:false,auditOffset:0,auditBusy:false,externalLoaded:false,oauthLoaded:false,oauthOffset:0,oauthBusy:false,delegationsLoaded:false,delegationOffset:0,delegationsBusy:false,revokeId:null,revokeKind:null};
const msg = e => e instanceof Error ? e.message : "请求暂时不可用";
async function api(path,options={}) {
  const response = await fetch(path,{...options,credentials:"same-origin",
    headers:{accept:"application/json",...(options.headers||{})}});
  const payload = await response.json().catch(()=>null);
  if(!response.ok || !payload || !Object.hasOwn(payload,"data")) {
    throw new Error(payload?.error?.message || "请求失败（HTTP "+response.status+"）");
  }
  return payload.data;
}
function el(tag,className,value) {
  const node=document.createElement(tag);
  if(className) node.className=className;
  if(value!==undefined) node.textContent=String(value);
  return node;
}
function label(item) { return item?.displayName || item?.name || item?.id || "—"; }
function setAvatar(target,name,url) {
  target.replaceChildren();
  if(typeof url === "string" && url.startsWith("https://auth") && url.includes("/assets/users/")) {
    const img=el("img");img.src=url;img.alt="";
    img.addEventListener("error",()=>target.replaceChildren(document.createTextNode((name||"A").slice(0,1))));
    target.append(img);
  } else target.textContent=(name||"A").slice(0,1);
}
function formatTime(value) {
  const date=new Date(value);
  return Number.isNaN(date.getTime()) ? "未知时间" : date.toLocaleString("zh-CN");
}
function showError(value) {
  $("session-error-message").textContent=value;
  $("session-error").hidden=false;
}
function clearError() { $("session-error").hidden=true; }
function updateUser(user) {
  state.user=user;
  $("nav-name").textContent=user.displayName;
  $("profile-name").textContent=user.displayName;
  $("profile-id").textContent=user.id;
  $("profile-subtitle").textContent="已验证 LifeSpace 用户身份";
  setAvatar($("nav-avatar"),user.displayName,user.avatarUrl);
  setAvatar($("profile-avatar"),user.displayName,user.avatarUrl);
}
async function loadAccount() {
  const session=await api("/api/session");
  if(!session?.user || typeof session.user.id!=="string" || typeof session.user.displayName!=="string"
    || typeof session.csrfToken!=="string") throw new Error("服务器未返回完整、受保护的账户会话");
  state.csrf=session.csrfToken;
  updateUser(session.user);
  try {
    const data=await api("/api/account/login-email");
    $("profile-email").textContent=data.email || "未设置";
    const names={linked:"已关联",pending:"待验证关联",unlinked:"未关联"};
    $("email-status").textContent=names[data.status] || "暂不可用";
    $("nav-email").textContent=data.linked && data.email ? data.email : "LifeSpace Identity";
  } catch(e) {
    $("profile-email").textContent="暂时无法读取";
    $("email-status").textContent="请刷新重试";
    $("nav-email").textContent="LifeSpace Identity";
  }
}
function currentPage() {
  const parts=location.hash.replace(/^#/u,"").split("/");
  return {view:PANELS.has(parts[0])?parts[0]:"account",tab:TABS.has(parts[1])?parts[1]:"oauth"};
}
function closeMenu() {
  $("sidebar").classList.remove("open");
  $("mobile-shade").hidden=true;
  $("mobile-menu").setAttribute("aria-expanded","false");
}
function navigate() {
  const {view,tab}=currentPage();
  for(const panel of document.querySelectorAll("[data-panel]")) panel.hidden=panel.dataset.panel!==view;
  for(const link of document.querySelectorAll("[data-view]")) {
    if(link.dataset.view===view)link.setAttribute("aria-current","page");
    else link.removeAttribute("aria-current");
  }
  if(view==="connections")selectTab(tab,false);
  const names={account:"账号与安全",spaces:"我的空间",connections:"连接与授权",audit:"活动与审计"};
  document.title=names[view]+" · AISR Account";
  closeMenu();
  if(view==="spaces" && state.user && !state.spacesLoaded)void loadSpaces();
  if(view==="audit" && state.csrf && !state.auditLoaded)void loadAudit(true);
}
function selectTab(tab,updateHash=true) {
  if(!TABS.has(tab))tab="oauth";
  for(const node of document.querySelectorAll("[data-tab]"))node.setAttribute("aria-selected",String(node.dataset.tab===tab));
  for(const node of document.querySelectorAll("[data-tab-panel]"))node.hidden=node.dataset.tabPanel!==tab;
  if(updateHash)location.hash="#connections/"+tab;
  if(tab==="delegations" && state.csrf && !state.delegationsLoaded)void loadDelegations(true);
  if(tab==="oauth" && state.csrf && !state.oauthLoaded)void loadOauth(true);
  if(tab==="external" && state.csrf && !state.externalLoaded)void loadExternal(true);
}
function renderSpaces() {
  const target=$("space-list");target.replaceChildren();
  if(!state.spaces.length){
    target.append(el("p","placeholder","当前没有已加入的 Space。"));
    return;
  }
  for(const space of state.spaces) {
    const button=el("button","space-choice");button.type="button";
    button.setAttribute("aria-pressed",String(state.space===space.id));
    const initial=el("span","space-initial",space.name.slice(0,1));
    const name=el("span");name.append(el("strong","",space.name),el("small","",space.timezone));
    button.append(initial,name,el("span","role",roles[space.role]||space.role));
    button.addEventListener("click",()=>{state.space=space.id;renderSpaces();void loadSpaceDetail(space.id);});
    target.append(button);
  }
}
async function loadSpaces() {
  $("space-list").replaceChildren(el("p","placeholder","正在读取当前用户的空间…"));
  try {
    const list=await api("/api/account/spaces");
    if(!Array.isArray(list))throw new Error("空间列表格式异常");
    state.spaces=list;
    state.spacesLoaded=true;
    if(state.space && !list.some(item=>item.id===state.space))state.space=null;
    if(!state.space && list.length)state.space=list[0].id;
    renderSpaces();
    if(state.space) await loadSpaceDetail(state.space);
    else $("space-detail").replaceChildren(el("p","placeholder","当前没有可查看的空间。"));
  } catch(e) {
    $("space-list").replaceChildren(el("p","placeholder","读取失败："+msg(e)));
  }
}
function detailRow(title,value) {
  const row=el("div","detail-row");row.append(el("span","",title),el("span","",value));return row;
}
async function loadSpaceDetail(id) {
  const target=$("space-detail");
  target.replaceChildren(el("p","placeholder","正在验证 Space 权限…"));
  try {
    const info=await api("/api/account/spaces/"+encodeURIComponent(id));
    if(state.space!==id)return;
    const space=state.spaces.find(item=>item.id===id);
    $("space-detail-label").textContent=roles[space?.role]||"当前成员";
    target.replaceChildren(el("h3","space-detail-title",info.name),
      detailRow("Space ID",info.id),detailRow("时区",info.timezone),
      detailRow("当前角色",roles[space?.role]||"已授权访问"));
    const divider=el("hr","section-divider");target.append(divider,el("h2","","成员"));
    const listing=el("div","member-list");target.append(listing);
    try {
      const members=await api("/api/account/spaces/"+encodeURIComponent(id)+"/members");
      if(state.space!==id)return;
      if(!Array.isArray(members))throw new Error("成员列表格式异常");
      if(!members.length) listing.append(el("p","placeholder","暂无可读取的成员。"));
      for(const member of members) {
        const row=el("div","member-row");
        const detail=el("span");detail.append(el("strong","",member.displayName),el("small","",member.userId));
        row.append(detail,el("span","role",roles[member.role]||member.role));
        listing.append(row);
      }
    } catch(e) {
      if(state.space===id)listing.append(el("p","placeholder","无法读取成员："+msg(e)));
    }
  } catch(e) {
    if(state.space===id)target.replaceChildren(el("p","placeholder","无法读取空间详情："+msg(e)));
  }
}
function auditRow(item) {
  const card=el("article","delegation-item"),head=el("div","delegation-head");
  const title=el("div");
  title.append(el("strong","",item.clientName),el("p","",item.resource));
  head.append(title,el("span","role",item.status==="revoked"?"已撤销":"有效"));
  card.append(head);
  const facts=el("div","delegation-tags");
  facts.append(el("span","tag","授权于 "+formatTime(item.createdAt)));
  if(item.revokedAt)facts.append(el("span","tag","撤销于 "+formatTime(item.revokedAt)));
  card.append(facts);
  const detail=el("details");
  detail.append(el("summary","","查看授权边界"));
  const list=el("dl");
  for(const [name,value] of [["Authorization",item.id],["Client ID",item.clientId],
    ["Space",item.spaceId],["Agent",item.agentId],["Application",item.applicationId]]){
    list.append(el("dt","",name),el("dd","",value));
  }
  detail.append(list);card.append(detail);return card;
}
async function loadAudit(reset=false) {
  if(state.auditBusy)return;
  state.auditBusy=true;
  const target=$("audit-items"),message=$("audit-message");
  $("more-audit").hidden=true;message.hidden=false;
  message.textContent="正在从 Identity 读取当前账户的 OAuth 授权活动…";
  try{
    const page=await api("/api/account/authorizations?offset="+(reset?0:state.auditOffset));
    if(!Array.isArray(page.items))throw new Error("活动记录响应异常");
    if(reset)target.replaceChildren();
    for(const item of page.items)target.append(auditRow(item));
    state.auditOffset=page.nextOffset??0;
    state.auditLoaded=true;
    $("more-audit").hidden=page.nextOffset===null;
    message.hidden=target.children.length>0;
    if(!message.hidden)message.textContent="当前没有可读取的 OAuth 授权活动。";
  }catch(e) {
    message.hidden=false;message.textContent="读取授权活动失败："+msg(e);
  }finally{state.auditBusy=false;}
}
async function loadExternal(reset=false) {
  const select=$("external-space"),target=$("external-items"),message=$("external-message");
  if(reset){
    select.replaceChildren(el("option","","读取空间中…"));
    select.disabled=true;
    try {
      // A Space manager is still rechecked by Core for each actual list read.
      const spaces=await api("/api/account/spaces");
      if(!Array.isArray(spaces))throw new Error("空间列表格式异常");
      const candidates=spaces.filter(item=>["owner","admin"].includes(item.role));
      select.replaceChildren();
      for(const space of candidates){
        const option=el("option","",space.name);option.value=space.id;select.append(option);
      }
      select.disabled=candidates.length===0;
      if(!candidates.length){
        target.replaceChildren();message.hidden=false;
        message.textContent="当前账户没有可管理的 Space，因此不能读取外部数据源配置。";
        state.externalLoaded=true;
        return;
      }
    } catch(e) {
      message.hidden=false;message.textContent="无法读取空间："+msg(e);
      target.replaceChildren();
      return;
    }
  }
  if(!select.value)return;
  target.replaceChildren();message.hidden=false;
  message.textContent="正在从 Core 读取 Space 内的外部数据源…";
  const selected=select.value;
  try{
    const data=await api("/api/account/spaces/"+encodeURIComponent(selected)+"/external-connections");
    if(select.value!==selected)return;
    if(!Array.isArray(data.items))throw new Error("数据源列表格式异常");
    for(const item of data.items){
      const article=el("article","delegation-item"),head=el("div","delegation-head");
      const details=el("div");
      details.append(el("strong","",item.displayName),el("p","",item.providerKey));
      head.append(details,el("span","role",item.status==="active"?"已启用":item.status==="revoked"?"已撤销":"已停用"));
      const chips=el("div","delegation-tags");
      chips.append(el("span","tag",item.access==="write"?"读写":"只读"));
      const more=el("details");more.append(el("summary","","查看连接元数据"));
      const dl=el("dl");
      for(const [name,value] of [["Connection",item.id],["Space",item.spaceId],
        ["Provider",item.providerKey],["创建时间",formatTime(item.createdAt)]]){
        dl.append(el("dt","",name),el("dd","",value));
      }
      more.append(dl);article.append(head,chips,more);target.append(article);
    }
    message.hidden=data.items.length>0;
    if(!message.hidden)message.textContent="当前 Space 尚未配置外部数据源。";
    state.externalLoaded=true;
  }catch(e){
    message.hidden=false;message.textContent="无法读取外部数据源："+msg(e);
  }
}
function authorizationRow(item) {
  const card=el("article","delegation-item"),head=el("div","delegation-head"),intro=el("div");
  intro.append(el("strong","",item.clientName),el("p","",item.clientId));
  const status=item.status==="active"?"有效授权":"已撤销";
  if(item.status==="active"){
    const button=el("button","button danger","撤销授权");button.type="button";
    button.addEventListener("click",()=>openRevoke(item,"oauth"));
    head.append(intro,button);
  }else head.append(intro,el("span","tag",status));
  const tags=el("div","delegation-tags");
  tags.append(el("span","tag",status),
    el("span","tag",item.allowUserAuthorization?"允许申请单独委托":"仅 Agent 自身权限"));
  for(const scope of item.scopes)tags.append(el("span","tag",scope));
  const detail=el("details");detail.append(el("summary","","查看授权实例与资源"));
  const dl=el("dl");
  for(const [name,value] of [["Authorization",item.id],["Client ID",item.clientId],
    ["Resource",item.resource],["Application",item.applicationId],["Space",item.spaceId],
    ["Agent",item.agentId],["授权于",formatTime(item.createdAt)],
    ["撤销于",item.revokedAt?formatTime(item.revokedAt):"—"]]) {
    dl.append(el("dt","",name),el("dd","",value));
  }
  detail.append(dl);card.append(head,tags,detail);return card;
}
async function loadOauth(reset=false) {
  if(state.oauthBusy)return;
  state.oauthBusy=true;
  const target=$("oauth-items"),label=$("oauth-message");
  $("more-oauth").hidden=true;
  label.textContent="正在读取当前用户的 OAuth 授权实例…";label.hidden=false;
  try {
    const offset=reset?0:state.oauthOffset;
    const page=await api("/api/account/authorizations?offset="+offset);
    if(!Array.isArray(page.items))throw new Error("授权列表格式异常");
    if(reset)target.replaceChildren();
    for(const item of page.items)target.append(authorizationRow(item));
    state.oauthOffset=page.nextOffset??0;
    state.oauthLoaded=true;
    $("more-oauth").hidden=page.nextOffset===null;
    label.hidden=target.children.length>0;
    if(!label.hidden)label.textContent="当前账户没有已创建的 OAuth 授权实例。";
  } catch(e) {
    label.hidden=false;label.textContent="读取 OAuth 授权失败："+msg(e);
  } finally {state.oauthBusy=false;}
}
function humanLifetime(item) {
  if(item.mode==="once")return "一次性";
  if(item.mode==="timed")return "限时 · "+(item.expiresAt?formatTime(item.expiresAt):"未知有效期");
  return "长期 · 直到撤销";
}
function delegationRow(item) {
  const card=el("article","delegation-item");
  const head=el("div","delegation-head");const intro=el("div");
  intro.append(el("strong","",(item.modelKey||"模型")+" · "+(opNames[item.operation]||item.operation)),
    el("p","","批准于 "+formatTime(item.createdAt)));
  const button=el("button","button danger","撤销");button.type="button";
  button.addEventListener("click",()=>openRevoke(item));
  head.append(intro,button);
  const tags=el("div","delegation-tags");
  tags.append(el("span","tag",humanLifetime(item)),el("span","tag",item.clientId));
  const detail=el("details");
  detail.append(el("summary","","查看授权边界"));
  const dl=el("dl");
  for(const [name,value] of [["Application",item.applicationId],["Space",item.spaceId],
    ["Agent",item.agentId],["MCP Resource",item.resource],["模型与操作",item.modelKey+" / "+item.operation],
    ["到期时间",item.expiresAt?formatTime(item.expiresAt):"不自动到期"]]) {
    dl.append(el("dt","",name),el("dd","",value));
  }
  detail.append(dl);card.append(head,tags,detail);return card;
}
async function loadDelegations(reset=false) {
  if(state.delegationsBusy)return;
  state.delegationsBusy=true;
  const target=$("delegation-items"),label=$("delegations-message");
  $("more-delegations").hidden=true;
  label.textContent="正在读取当前有效委托…";label.hidden=false;
  try {
    const offset=reset?0:state.delegationOffset;
    const page=await api("/api/delegations?offset="+offset);
    if(!Array.isArray(page.items))throw new Error("委托列表格式异常");
    if(reset)target.replaceChildren();
    for(const item of page.items)target.append(delegationRow(item));
    state.delegationOffset=page.nextOffset??0;
    state.delegationsLoaded=true;
    $("more-delegations").hidden=page.nextOffset===null;
    label.hidden=target.children.length>0;
    if(!label.hidden)label.textContent="当前没有有效的第三方 Agent 委托。";
  } catch(e) {
    label.hidden=false;label.textContent="读取委托失败："+msg(e);
  } finally {
    state.delegationsBusy=false;
  }
}
function openRevoke(item,kind="delegation") {
  if(state.delegationsBusy || state.oauthBusy || !state.csrf)return;
  state.revokeId=item.id;state.revokeKind=kind;
  $("revoke-detail").textContent=kind==="oauth"
    ? "确认撤销「"+item.clientName+"」当前授权实例？此客户端的旧 Token 将失效，但其他授权和共享 Agent 不受影响。"
    : "确认撤销「"+item.modelKey+" · "+(opNames[item.operation]||item.operation)
      +"」？后续调用将被拒绝，已经完成的操作不会撤回。";
  $("revoke-error").hidden=true;
  $("revoke-dialog").showModal();
}
function closeRevoke() {
  if(state.delegationsBusy)return;
  state.revokeId=null;state.revokeKind=null;
  $("revoke-dialog").close();
}
async function revoke() {
  if(!state.revokeId || state.delegationsBusy || state.oauthBusy)return;
  const selectedId=state.revokeId,kind=state.revokeKind;
  const confirm=$("revoke-confirm"),cancel=$("revoke-cancel");
  confirm.disabled=true;cancel.disabled=true;
  try {
    await api(kind==="oauth"
      ? "/api/account/authorizations/"+encodeURIComponent(selectedId)+"/revoke"
      : "/api/delegations/revoke",{method:"POST",
      headers:{"content-type":"application/json","x-lifespace-csrf":state.csrf},
      body:JSON.stringify(kind==="oauth"
        ? {intent:"revoke-oauth-authorization",authorizationId:selectedId}
        : {intent:"revoke-user-delegation",delegationId:selectedId})});
    state.revokeId=null;state.revokeKind=null;
    $("revoke-dialog").close();
    if(kind==="oauth"){
      state.oauthLoaded=false;
      await loadOauth(true);
      $("oauth-message").textContent="OAuth 授权已撤销，列表已从服务器刷新。";
      $("oauth-message").hidden=false;
    }else{
      state.delegationsLoaded=false;
      await loadDelegations(true);
      $("delegations-message").textContent="委托已撤销，列表已从服务器刷新。";
      $("delegations-message").hidden=false;
    }
  } catch(e) {
    $("revoke-error").textContent="撤销未完成："+msg(e);
    $("revoke-error").hidden=false;
  } finally {
    confirm.disabled=false;cancel.disabled=false;
  }
}
async function init() {
  clearError();
  try {
    await loadAccount();
    if(currentPage().view==="spaces")await loadSpaces();
    if(currentPage().view==="connections"){
      if(currentPage().tab==="delegations")await loadDelegations(true);
      if(currentPage().tab==="oauth")await loadOauth(true);
      if(currentPage().tab==="external")await loadExternal(true);
    }
    if(currentPage().view==="audit")await loadAudit(true);
  } catch(e) {
    showError(msg(e));
    $("nav-name").textContent="身份尚未验证";
    $("profile-name").textContent="暂时无法验证账号";
    $("profile-email").textContent="不可用";
    $("email-status").textContent="不可用";
  }
}
$("retry").addEventListener("click",init);
$("refresh-spaces").addEventListener("click",loadSpaces);
$("refresh-delegations").addEventListener("click",()=>loadDelegations(true));
$("refresh-oauth").addEventListener("click",()=>loadOauth(true));
$("refresh-external").addEventListener("click",()=>loadExternal(true));
$("refresh-audit").addEventListener("click",()=>loadAudit(true));
$("more-audit").addEventListener("click",()=>loadAudit(false));
$("external-space").addEventListener("change",()=>loadExternal(false));
$("more-oauth").addEventListener("click",()=>loadOauth(false));
$("more-delegations").addEventListener("click",()=>loadDelegations(false));
$("revoke-confirm").addEventListener("click",revoke);
$("revoke-cancel").addEventListener("click",closeRevoke);
$("revoke-dialog").addEventListener("cancel",e=>{if(state.delegationsBusy||state.oauthBusy)e.preventDefault();else {state.revokeId=null;state.revokeKind=null;}});
$("mobile-menu").addEventListener("click",()=>{
  const open=!$("sidebar").classList.contains("open");
  $("sidebar").classList.toggle("open",open);
  $("mobile-shade").hidden=!open;
  $("mobile-menu").setAttribute("aria-expanded",String(open));
});
$("mobile-shade").addEventListener("click",closeMenu);
for(const tab of document.querySelectorAll("[data-tab]")){
  tab.addEventListener("click",()=>selectTab(tab.dataset.tab));
}
window.addEventListener("hashchange",navigate);
navigate();
void init();

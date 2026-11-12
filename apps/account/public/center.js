const $ = id => document.getElementById(id);
const PANELS = new Set(["account","spaces","connections","audit"]);
const TABS = new Set(["oauth","delegations","external"]);
const roles = {owner:"所有者",admin:"管理员",editor:"编辑者",viewer:"查看者"};
const opNames = {query:"查询",get:"查看",create:"新增",update:"修改",delete:"删除"};
const state = {user:null,csrf:null,spaces:[],space:null,auditLoaded:false,auditOffset:0,auditBusy:false,externalLoaded:false,oauthLoaded:false,oauthOffset:0,oauthBusy:false,delegationsLoaded:false,delegationOffset:0,delegationsBusy:false,revokeId:null,revokeKind:null,revokeBusy:false,emailVersion:null,emailValue:null,invite:null,spaceNames:new Map(),nameCandidates:[],referenceLoaded:false,busyAction:false};
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
    const img=el("img");img.src=url+(url.includes("?")?"&":"?")+"v="+Date.now();img.alt="";
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
function notice(id,message,error=false){const n=$(id);n.textContent=message;n.hidden=!message;n.dataset.error=String(error);}
async function post(path,value){return api(path,{method:"POST",headers:{"content-type":"application/json","x-lifespace-csrf":state.csrf},body:JSON.stringify(value)});}
function updateUser(user) {
  state.user=user;
  $("nav-name").textContent=user.displayName;
  $("profile-name").textContent=user.displayName;
  $("profile-id").textContent=user.id;
  $("profile-subtitle").textContent="我的个人资料";
  $("name-input").value=user.displayName;
  $("name-edit").disabled=!state.csrf;
  setAvatar($("nav-avatar"),user.displayName,user.avatarUrl);
  setAvatar($("profile-avatar"),user.displayName,user.avatarUrl);
}
async function loadAccount() {
  const session=await api("/api/session?include=login-email");
  if(!session?.user || typeof session.user.id!=="string" || typeof session.user.displayName!=="string"
    || typeof session.csrfToken!=="string") throw new Error("服务器未返回完整、受保护的账户会话");
  state.csrf=session.csrfToken;
  updateUser(session.user);
  try {
    const data=session.loginEmail;
    if(!data || !Number.isSafeInteger(data.version))throw new Error("邮箱暂不可用");
    state.emailVersion=data.version;
    state.emailValue=data.email || "";
    $("email-edit").disabled=!Number.isSafeInteger(data.version);
    $("profile-email").textContent=data.email || "未设置";
    $("email-input").value=data.email || "";
    const names={linked:"已验证邮箱",pending:"等待新邮箱验证",unlinked:"尚未关联邮箱"};
    $("email-status").textContent=names[data.status] || "暂不可用";
    $("nav-email").textContent=data.email || "账户中心";
    notice("email-note",data.status==="pending"
      ?"新邮箱尚未验证。请使用新的邮箱完成登录验证后再继续。":"");
  } catch(e) {
    $("profile-email").textContent="暂时无法读取";
    $("email-status").textContent="请刷新重试";
    $("nav-email").textContent="账户中心";
    state.emailVersion=null;
    state.emailValue=null;
    $("email-input").value="";
    $("email-edit").disabled=true;
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
  document.title="账户中心";
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
    target.append(el("p","placeholder","还没有空间，可创建或通过邀请加入。"));
    return;
  }
  for(const space of state.spaces) {
    const button=el("button","space-choice");button.type="button";
    button.setAttribute("aria-pressed",String(state.space===space.id));
    const initial=el("span","space-initial",space.name.slice(0,1));
    const name=el("span");name.append(el("strong","",space.name),el("small","",roles[space.role]||space.role));
    button.append(initial,name);
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
    state.spaceNames=new Map(list.map(space=>[space.id,space.name]));
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
      detailRow("时区",info.timezone),
      detailRow("我的角色",roles[space?.role]||"已授权访问"));
    const divider=el("hr","section-divider");target.append(divider,el("h2","","成员"));
    const listing=el("div","member-list");target.append(listing);
    try {
      const members=await api("/api/account/spaces/"+encodeURIComponent(id)+"/members");
      if(state.space!==id)return;
      if(!Array.isArray(members))throw new Error("成员列表格式异常");
      if(!members.length) listing.append(el("p","placeholder","暂无可读取的成员。"));
      for(const member of members) {
        const row=el("div","member-row");
        const detail=el("span");detail.append(el("strong","",member.displayName));
        row.append(detail,el("span","role",roles[member.role]||member.role));
        listing.append(row);
      }
      const tech=el("details","technical-details");
      tech.append(el("summary","","空间标识"),detailRow("Space ID",info.id));
      target.append(tech);
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
  title.append(el("strong","",item.clientName),el("p","","授权空间："+(state.spaceNames.get(item.spaceId)||"已关联空间")));
  head.append(title,el("span","role",item.status==="revoked"?"已撤销":"未撤销"));
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
  message.textContent="正在读取授权记录…";
  try{
    await loadReferenceNames();
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
  message.textContent="正在读取数据连接…";
  const selected=select.value;
  try{
    const data=await api("/api/account/spaces/"+encodeURIComponent(selected)+"/external-connections");
    if(select.value!==selected)return;
    if(!Array.isArray(data.items))throw new Error("数据源列表格式异常");
    for(const item of data.items){
      const article=el("article","delegation-item"),head=el("div","delegation-head");
      const details=el("div");
      details.append(el("strong","",item.displayName),el("p","","连接到 "+(state.spaceNames.get(item.spaceId)||"当前空间")));
      head.append(details,el("span","role",item.status==="active"?"已启用":item.status==="revoked"?"已撤销":"已停用"));
      const chips=el("div","delegation-tags");
      chips.append(el("span","tag",item.access==="write"?"读写":"只读"));
      const more=el("details");more.append(el("summary","","技术详情"));
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
async function loadReferenceNames(){
  if(state.referenceLoaded)return;
  state.referenceLoaded=true;
  const [spaces,choices]=await Promise.allSettled([
    api("/api/account/spaces"),api("/api/oauth/choices"),
  ]);
  if(spaces.status==="fulfilled" && Array.isArray(spaces.value)){
    state.spaceNames=new Map(spaces.value.map(item=>[item.id,item.name]));
  }
  if(choices.status==="fulfilled" && Array.isArray(choices.value?.candidates)){
    state.nameCandidates=choices.value.candidates;
  }
}
function readableContext(item){
  const exact=state.nameCandidates.find(x=>x.spaceId===item.spaceId
    && x.applicationId===item.applicationId && x.agentId===item.agentId);
  const parts=[state.spaceNames.get(item.spaceId)||exact?.spaceName,
    exact?.applicationName,exact?.agentName].filter(Boolean);
  return parts.length?parts.join(" · "):"已授权访问的空间";
}
function authorizationRow(item) {
  const card=el("article","delegation-item"),head=el("div","delegation-head"),intro=el("div");
  intro.append(el("strong","",item.clientName),
    el("p","",readableContext(item)),
    el("p","","授权于 "+formatTime(item.createdAt)));
  const status=item.status==="active"?"未撤销":"已撤销";
  if(item.status==="active"){
    const button=el("button","button danger","断开此授权");button.type="button";
    button.addEventListener("click",()=>openRevoke(item,"oauth"));
    head.append(intro,button);
  }else head.append(intro);
  const tags=el("div","delegation-tags");
  tags.append(el("span","tag",status),
    el("span","tag","申请范围："+(item.scopes.includes("resources:write")?"读取、写入":"读取")));
  if(item.allowUserAuthorization)tags.append(el("span","tag","可申请额外授权"));
  const detail=el("details");detail.append(el("summary","","技术详情"));
  const dl=el("dl");
  for(const [name,value] of [["Authorization",item.id],["Client ID",item.clientId],
    ["Resource",item.resource],["Application",item.applicationId],["Space",item.spaceId],
    ["Agent",item.agentId],["OAuth Scope",item.scopes.join(", ")],
    ["授权实例",item.id.slice(-8)],["授权于",formatTime(item.createdAt)],
    ["撤销于",item.revokedAt?formatTime(item.revokedAt):"—"]]) {
    dl.append(el("dt","",name),el("dd","",value));
  }
  detail.append(dl);card.append(head,tags,detail);return card;
}
async function loadOauth(reset=false) {
  if(state.oauthBusy)return false;
  state.oauthBusy=true;
  const target=$("oauth-items"),label=$("oauth-message");
  $("more-oauth").hidden=true;
  label.textContent="正在读取连接…";label.hidden=false;
  try {
    const offset=reset?0:state.oauthOffset;
    await loadReferenceNames();
    const page=await api("/api/account/authorizations?offset="+offset);
    if(!Array.isArray(page.items))throw new Error("授权列表格式异常");
    if(reset)target.replaceChildren();
    for(const item of page.items)target.append(authorizationRow(item));
    state.oauthOffset=page.nextOffset??0;
    state.oauthLoaded=true;
    $("more-oauth").hidden=page.nextOffset===null;
    label.hidden=target.children.length>0;
    if(!label.hidden)label.textContent="当前账户没有已创建的 OAuth 授权实例。";
    return true;
  } catch(e) {
    label.hidden=false;label.textContent="读取 OAuth 授权失败："+msg(e);
    return false;
  } finally {state.oauthBusy=false;}
}
function humanLifetime(item) {
  if(item.mode==="once")return "一次性";
  if(item.mode==="timed")return "限时";
  return "长期 · 直到撤销";
}
function delegationRow(item) {
  const card=el("article","delegation-item");
  const head=el("div","delegation-head");const intro=el("div");
  intro.append(el("strong","",(item.modelKey||"数据")+" · "+(opNames[item.operation]||item.operation)),
    el("p","",(state.spaceNames.get(item.spaceId)||"已授权空间")+" · 批准于 "+formatTime(item.createdAt)));
  const button=el("button","button danger","撤销");button.type="button";
  button.addEventListener("click",()=>openRevoke(item));
  head.append(intro,button);
  const tags=el("div","delegation-tags");
  tags.append(el("span","tag",humanLifetime(item)));
  tags.append(el("span","tag",item.expiresAt
    ?"到期："+formatTime(item.expiresAt):"无固定到期时间"));
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
  if(state.delegationsBusy)return false;
  state.delegationsBusy=true;
  const target=$("delegation-items"),label=$("delegations-message");
  $("more-delegations").hidden=true;
  label.textContent="正在读取委托…";label.hidden=false;
  try {
    const offset=reset?0:state.delegationOffset;
    await loadReferenceNames();
    const page=await api("/api/delegations?offset="+offset);
    if(!Array.isArray(page.items))throw new Error("委托列表格式异常");
    if(reset)target.replaceChildren();
    for(const item of page.items)target.append(delegationRow(item));
    state.delegationOffset=page.nextOffset??0;
    state.delegationsLoaded=true;
    $("more-delegations").hidden=page.nextOffset===null;
    label.hidden=target.children.length>0;
    if(!label.hidden)label.textContent="当前没有有效的第三方 Agent 委托。";
    return true;
  } catch(e) {
    label.hidden=false;label.textContent="读取委托失败："+msg(e);
    return false;
  } finally {
    state.delegationsBusy=false;
  }
}
function openRevoke(item,kind="delegation") {
  if(state.revokeBusy || state.delegationsBusy || state.oauthBusy || !state.csrf)return;
  state.revokeId=item.id;state.revokeKind=kind;
  $("revoke-heading").textContent=kind==="oauth"?"断开应用授权":"撤销委托授权";
  $("revoke-detail").textContent=kind==="oauth"
    ? "断开「"+item.clientName+"」的这一条授权？其他授权不会受影响。授权编号："+item.id.slice(-8)
    : "确认撤销「"+item.modelKey+" · "+(opNames[item.operation]||item.operation)
      +"」？后续调用将被拒绝，已经完成的操作不会撤回。";
  $("revoke-error").hidden=true;
  $("revoke-dialog").showModal();
}
function closeRevoke() {
  if(state.revokeBusy || state.delegationsBusy || state.oauthBusy)return;
  state.revokeId=null;state.revokeKind=null;
  $("revoke-dialog").close();
}
async function revoke() {
  if(!state.revokeId || state.revokeBusy || state.delegationsBusy || state.oauthBusy)return;
  const selectedId=state.revokeId,kind=state.revokeKind;
  const confirm=$("revoke-confirm"),cancel=$("revoke-cancel");
  state.revokeBusy=true;
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
    state.auditLoaded=false;
    $("revoke-dialog").close();
    if(kind==="oauth"){
      state.oauthLoaded=false;
      const refreshed=await loadOauth(true);
      if(!refreshed)$("oauth-items").replaceChildren();
      $("oauth-message").textContent=refreshed
        ? "已断开这条授权。"
        : "OAuth 授权已撤销，但列表刷新失败，请点击“刷新”核对当前状态。";
      $("oauth-message").hidden=false;
    }else{
      state.delegationsLoaded=false;
      const refreshed=await loadDelegations(true);
      if(!refreshed)$("delegation-items").replaceChildren();
      $("delegations-message").textContent=refreshed
        ? "委托已撤销，服务器列表已更新。"
        : "委托已撤销，但列表刷新失败，请点击“刷新”核对当前状态。";
      $("delegations-message").hidden=false;
    }
  } catch(e) {
    $("revoke-error").textContent="撤销未完成："+msg(e);
    $("revoke-error").hidden=false;
  } finally {
    state.revokeBusy=false;
    confirm.disabled=false;cancel.disabled=false;
  }
}

function busySubmit(form,busy){
  for(const control of form.querySelectorAll("button,input,select"))control.disabled=busy;
}
function setProfileEdit(kind,editing){
  const name=kind==="name";
  const prefix=name?"name":"email";
  const input=$(prefix+"-input");
  if(editing){
    if(state.busyAction || !state.csrf || (name?!state.user:!Number.isSafeInteger(state.emailVersion)))return;
  }else{
    input.value=name?(state.user?.displayName||""):(state.emailValue||"");
  }
  input.readOnly=!editing;
  $(prefix+"-edit").hidden=editing;
  $(prefix+"-cancel").hidden=!editing;
  $(prefix+"-save").hidden=!editing;
  if(editing)input.focus();
}
function bindForms(){
  for(const kind of ["name","email"]){
    $(kind+"-edit").addEventListener("click",()=>setProfileEdit(kind,true));
    $(kind+"-cancel").addEventListener("click",()=>{
      if(state.busyAction)return;
      setProfileEdit(kind,false);
    });
  }
  $("logout").addEventListener("click",()=>{
    if(state.busyAction || state.revokeBusy)return;
    if(!window.confirm("退出将结束 Cloudflare Access 登录，其他使用相同 Access 登录的应用也可能需要重新登录。已有 OAuth 和 AI 委托授权不会撤销。确定退出吗？"))return;
    state.csrf=null;
    window.location.assign("/cdn-cgi/access/logout");
  });
  $("profile-form").addEventListener("submit",async event=>{
    event.preventDefault();
    if(state.busyAction || !state.csrf || $("name-input").readOnly)return;
    const displayName=$("name-input").value.trim();
    if(!displayName)return;
    if(displayName===state.user?.displayName){
      setProfileEdit("name",false);
      notice("account-action-status","姓名没有变化。");
      return;
    }
    state.busyAction=true;busySubmit($("profile-form"),true);
    try{
      const result=await post("/api/account/profile",{intent:"update-profile",displayName});
      updateUser({...state.user,displayName:result.displayName});
      setProfileEdit("name",false);
      notice("account-action-status","姓名已保存。");
    }catch(e){notice("account-action-status","姓名保存失败："+msg(e),true);}
    finally{
      state.busyAction=false;busySubmit($("profile-form"),false);
      $("name-edit").disabled=!Boolean(state.csrf && state.user);
    }
  });
  $("avatar-upload").addEventListener("click",()=>$("avatar-file").click());
  $("avatar-file").addEventListener("change",async()=>{
    const file=$("avatar-file").files?.[0];
    if(!file || state.busyAction || !state.csrf)return;
    if(file.size>5*1024*1024 || !["image/png","image/jpeg","image/webp"].includes(file.type)){
      notice("account-action-status","请上传不超过 5 MB 的 JPG、PNG 或 WebP 图片。",true);
      return;
    }
    state.busyAction=true;$("avatar-upload").disabled=true;
    try{
      const body=new FormData();body.append("avatar",file,file.name);
      const result=await api("/api/account/profile/avatar",{
        method:"POST",headers:{"x-lifespace-csrf":state.csrf},body,
      });
      updateUser({...state.user,avatarUrl:result.avatarUrl});
      notice("account-action-status","头像已更新。");
    }catch(e){notice("account-action-status","头像上传失败："+msg(e),true);}
    finally{state.busyAction=false;$("avatar-upload").disabled=false;$("avatar-file").value="";}
  });
  $("email-form").addEventListener("submit",async event=>{
    event.preventDefault();
    if(state.busyAction || !state.csrf || $("email-input").readOnly)return;
    const email=$("email-input").value.trim().toLowerCase();
    if(!email || !Number.isSafeInteger(state.emailVersion)){
      notice("account-action-status","请刷新账户信息后重试。",true);return;
    }
    if(email===state.emailValue){
      setProfileEdit("email",false);
      notice("account-action-status","邮箱没有变化。");return;
    }
    if(!window.confirm("更改登录邮箱需要验证新邮箱，且原邮箱的部分登录方式可能立即失效。确定继续吗？"))return;
    state.busyAction=true;busySubmit($("email-form"),true);
    try{
      const result=await post("/api/account/login-email/change",{
        intent:"change-login-email",email,version:state.emailVersion,
      });
      state.emailVersion=result.version;
      state.emailValue=result.email;
      $("profile-email").textContent=result.email;
      $("email-input").value=result.email;
      $("nav-email").textContent=result.email;
      $("email-status").textContent=result.linked?"已验证邮箱":"等待新邮箱验证";
      setProfileEdit("email",false);
      notice("email-note",result.linked?"":"请使用新邮箱完成登录验证。当前浏览器的登录状态可能发生变化。");
      notice("account-action-status",result.linked?"邮箱已保存。":"邮箱已更新，待验证新邮箱。");
    }catch(e){notice("account-action-status","邮箱变更失败："+msg(e),true);}
    finally{
      state.busyAction=false;busySubmit($("email-form"),false);
      $("email-edit").disabled=!Number.isSafeInteger(state.emailVersion);
    }
  });
  $("space-create-toggle").addEventListener("click",()=>{
    $("space-create-form").hidden=!$("space-create-form").hidden;
    $("space-invite-form").hidden=true;notice("space-action-status","");
  });
  $("space-join-toggle").addEventListener("click",()=>{
    $("space-invite-form").hidden=!$("space-invite-form").hidden;
    $("space-create-form").hidden=true;notice("space-action-status","");
  });
  $("space-create-cancel").addEventListener("click",()=>$("space-create-form").hidden=true);
  $("space-invite-cancel").addEventListener("click",()=>{
    $("space-invite-form").hidden=true;state.invite=null;
    $("space-invite-preview").hidden=true;$("space-join-confirm").hidden=true;
  });
  $("space-create-form").addEventListener("submit",async event=>{
    event.preventDefault();
    if(state.busyAction || !state.csrf)return;
    state.busyAction=true;busySubmit($("space-create-form"),true);
    try{
      const result=await post("/api/account/spaces/create",{
        intent:"create-space",name:$("space-name-input").value.trim(),
        timezone:$("space-zone-input").value,
      });
      $("space-create-form").hidden=true;
      $("space-name-input").value="";
      state.space=result.id;
      await loadSpaces();
      notice("space-action-status","空间「"+result.name+"」已创建。");
    }catch(e){notice("space-action-status","创建失败："+msg(e),true);}
    finally{state.busyAction=false;busySubmit($("space-create-form"),false);}
  });
  $("space-invite-input").addEventListener("input",()=>{
    state.invite=null;$("space-invite-preview").hidden=true;
    $("space-join-confirm").hidden=true;
  });
  $("space-invite-form").addEventListener("submit",async event=>{
    event.preventDefault();
    if(state.busyAction || !state.csrf)return;
    const token=$("space-invite-input").value.trim();
    if(!token)return;
    state.busyAction=true;busySubmit($("space-invite-form"),true);
    try{
      const preview=await post("/api/account/spaces/invite-preview",{
        intent:"preview-space-invite",token,
      });
      state.invite=preview.canJoin?{token,spaceId:preview.space.id}:null;
      $("space-invite-preview").textContent=preview.canJoin
        ?"即将加入「"+preview.space.name+"」 · "+(roles[preview.role]||"成员")
        :"这份邀请当前不可使用。";
      $("space-invite-preview").hidden=false;
      $("space-join-confirm").hidden=!preview.canJoin;
    }catch(e){
      $("space-invite-preview").textContent="邀请码验证失败："+msg(e);
      $("space-invite-preview").hidden=false;state.invite=null;
    }finally{state.busyAction=false;busySubmit($("space-invite-form"),false);}
  });
  $("space-join-confirm").addEventListener("click",async()=>{
    if(state.busyAction || !state.csrf || !state.invite)return;
    const token=$("space-invite-input").value.trim();
    if(token!==state.invite.token)return;
    const accepted=state.invite;
    state.busyAction=true;$("space-join-confirm").disabled=true;
    try{
      const result=await post("/api/account/spaces/join",{intent:"join-space",token});
      if(result.spaceId!==accepted.spaceId)throw Error("加入的空间与邀请预览不一致，请重新检查");
      $("space-invite-form").hidden=true;$("space-invite-input").value="";
      $("space-invite-preview").hidden=true;$("space-join-confirm").hidden=true;
      state.invite=null;state.space=result.spaceId;
      await loadSpaces();
      notice("space-action-status","已加入空间。");
    }catch(e){notice("space-action-status","加入失败："+msg(e),true);}
    finally{state.busyAction=false;$("space-join-confirm").disabled=false;}
  });
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
$("revoke-dialog").addEventListener("cancel",e=>{if(state.revokeBusy||state.delegationsBusy||state.oauthBusy)e.preventDefault();else {state.revokeId=null;state.revokeKind=null;}});
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
bindForms();
window.addEventListener("hashchange",navigate);
navigate();
void init();

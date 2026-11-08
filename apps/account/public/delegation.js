const $ = id => document.getElementById(id);
const REQUEST = /^arq_[a-f0-9]{32}$/u;
const labels = {get:"读取单条记录",query:"查询记录",create:"创建记录",update:"修改记录",delete:"删除记录"};
const id = new URL(location.href).searchParams.get("request_id");
let csrf = "", busy = false, record = null;
const show = (key,yes) => $(key).classList.toggle("hidden",!yes);
async function call(path,options={}) {
  const reply = await fetch(path,{...options,credentials:"same-origin",
    headers:{accept:"application/json",...(options.headers||{})}});
  const result = await reply.json().catch(()=>null);
  if (!reply.ok || !result?.data) throw new Error(result?.error?.message||"服务器拒绝了该请求");
  return result.data;
}
function error(message) {
  show("loading",false);show("content",false);show("done",false);show("error",true);
  $("error-message").textContent=message;
}
function fill(request,user){
  const fields = {
    agent:request.agentId,application:request.applicationId,client:request.clientId,
    space:request.spaceId,resource:request.resource,model:request.modelKey,
    operation:labels[request.operation]||request.operation,reason:request.reason,
    expiry:new Date(request.expiresAt).toLocaleString(),
  };
  for(const [key,value] of Object.entries(fields))$(key).textContent=value;
  $("user").textContent="已登录："+user.displayName;
}
function finish(status) {
  show("loading",false);show("error",false);show("content",false);show("done",true);
  $("done-title").textContent=status==="approved"?"委托已获批准":"已拒绝本次委托";
  $("done-message").textContent=status==="approved"?
    "已生成有次数与时限约束的 Delegation；原 Agent 必须持有效 OAuth 凭证并且通过 Core 权限校验才能执行。":
    "本次申请未产生 Delegation。";
}
async function init(){
  if(!REQUEST.test(id||"")) {error("无效的委托确认链接");return;}
  try {
    const [session,request]=await Promise.all([
      call("/api/session"),
      call("/api/delegation/request?request_id="+encodeURIComponent(id))
    ]);
    csrf=session.csrfToken;record=request;
    if(!csrf||!session.user?.id)throw new Error("登录会话无法确认");
    if(request.status==="approved"||request.status==="denied"){finish(request.status);return;}
    if(request.status!=="pending")throw new Error("申请已过期，请让 Agent 重新发起");
    fill(request,session.user);
    show("loading",false);show("error",false);show("content",true);
  } catch(e){error(e.message||"无法加载委托申请");}
}
async function decide(approve){
  if(busy||!record||record.status!=="pending"||!csrf)return;
  busy=true;$("approve").disabled=true;$("deny").disabled=true;
  try{
    const status=await call("/api/delegation/"+(approve?"approve":"deny"),{
      method:"POST",headers:{"content-type":"application/json","x-lifespace-csrf":csrf},
      body:JSON.stringify({intent:approve?"approve-user-delegation":"deny-user-delegation",requestId:id}),
    });
    finish(status.status);
  }catch(e){error(e.message||"委托确认失败");}
  finally{busy=false;$("approve").disabled=false;$("deny").disabled=false;}
}
$("retry").addEventListener("click",()=>{show("error",false);show("loading",true);init();});
$("approve").addEventListener("click",()=>decide(true));
$("deny").addEventListener("click",()=>decide(false));
init();

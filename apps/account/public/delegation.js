const $ = id => document.getElementById(id);
const REQUEST = /^arq_[a-f0-9]{32}$/u;
const labels = {get:"读取单条记录",query:"查询记录",create:"创建记录",update:"修改记录",delete:"删除记录"};
const id = new URL(location.href).searchParams.get("request_id");
let csrf = "", busy = false, record = null;
const chosenMode=()=>document.querySelector('input[name="delegation-mode"]:checked')?.value||"once";
function updateLifetime(){
  const mode=chosenMode();
  $("duration").disabled=mode!=="timed";
  $("approve").textContent=mode==="once"?"允许这一次":mode==="timed"?"允许限时操作":"允许长期操作";
  $("lifetime-warning").textContent=mode==="once"?"仅一次执行；批准后 30 分钟内有效。"
    :mode==="timed"?"授权期间可反复执行上述模型操作，直到过期或被你撤销。"
    :"高权限提醒：此授权不会自动过期，Agent 可持续执行上述模型操作，直到你主动撤销。";
}
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
    "已记录你选择的委托期限，仍须实时满足 OAuth、Space / Grant 与模型权限。你可以在授权管理页撤销。":
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
  const mode=chosenMode();
  if(approve && mode!=="once"){
    const detail=mode==="timed"?"在 "+$("duration").selectedOptions[0].textContent+" 内可重复执行"
      :"长期有效，直到你主动撤销";
    if(!confirm("确认允许这个 Agent "+detail+"？\\n它可能修改所选模型内多条记录。"))return;
  }
  busy=true;$("approve").disabled=true;$("deny").disabled=true;
  try{
    const status=await call("/api/delegation/"+(approve?"approve":"deny"),{
      method:"POST",headers:{"content-type":"application/json","x-lifespace-csrf":csrf},
      body:JSON.stringify({intent:approve?"approve-user-delegation":"deny-user-delegation",requestId:id,
        ...(approve?{mode,...(mode==="timed"?{durationMinutes:Number($("duration").value)}:{})}:{})}),
    });
    finish(status.status);
  }catch(e){error(e.message||"委托确认失败");}
  finally{busy=false;$("approve").disabled=false;$("deny").disabled=false;}
}
document.querySelectorAll('input[name="delegation-mode"]').forEach(el=>el.addEventListener("change",updateLifetime));
updateLifetime();
$("retry").addEventListener("click",()=>{show("error",false);show("loading",true);init();});
$("approve").addEventListener("click",()=>decide(true));
$("deny").addEventListener("click",()=>decide(false));
init();

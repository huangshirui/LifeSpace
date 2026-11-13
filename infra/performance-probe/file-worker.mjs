const CORE = "https://core-staging.aisr.online";
const MIME = "application/octet-stream";
export const SIZES = [100*1024, 1024*1024, 5*1024*1024, 10*1024*1024];
const check = (ok, code) => { if (!ok) throw Error(code); };
const isId = (value, prefix) => typeof value === "string" && new RegExp("^"+prefix+"_[a-f0-9]{32}$","u").test(value);
const json = (value,status=200) => Response.json(value,{status,headers:{"cache-control":"no-store"}});
const round = n => Math.round(n*10)/10;
function configured(e) {
  return typeof e.PROBE_TOKEN==="string" && e.PROBE_TOKEN.length>=32 && !!e.USER_BEARER
    && isId(e.SPACE_ID,"spc") && /^smoke_file_bench_[0-9]+_[1-9][0-9]*$/u.test(e.MODEL_KEY??"");
}
function signedUrl(raw, key) {
  let url; try { url=new URL(raw); } catch { throw Error("invalid_signed_url"); }
  check(url.protocol==="https:" && !url.username && !url.password && !url.port && !url.hash
    && /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u.test(url.hostname)
    && url.pathname==="/lifespace-staging-assets/"+key && url.searchParams.has("X-Amz-Signature"),"invalid_signed_url");
  return url.href;
}
async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function runFileSample(env,size,fetchImpl=fetch) {
  check(configured(env)&&SIZES.includes(size),"invalid_fixture");
  const root="/api/v1/spaces/"+env.SPACE_ID;
  const model=root+"/models/"+env.MODEL_KEY+"/records";
  const marker=crypto.randomUUID().replaceAll("-","");
  const name="synthetic-"+marker+".bin";
  const bytes=new Uint8Array(size);
  const pattern=new TextEncoder().encode(marker);
  for(let i=0;i<size;i++)bytes[i]=pattern[i%pattern.length]^(i%251);
  const hash=await digest(bytes);
  const timings={};
  let file=null,record=null,stage="session",failure=null,cleanupOk=true,completeRequestId=null;
  async function core(path,method,body,status,metric) {
    const correlation=crypto.randomUUID(),start=performance.now();
    const res=await fetchImpl(CORE+path,{method,redirect:"error",signal:AbortSignal.timeout(60000),
      headers:{authorization:"Bearer "+env.USER_BEARER,"x-request-id":correlation,
        ...(body===undefined?{}:{"content-type":"application/json"})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(metric)timings[metric+"HeadersMs"]=round(performance.now()-start);
    if(metric==="finalize")completeRequestId=res.headers.get("x-request-id")===correlation?correlation:null;
    check(res.status===status,"unexpected_http");
    const data=status===204?null:(await res.json()).data;
    if(metric)timings[metric+"Ms"]=round(performance.now()-start);
    return data;
  }
  const start=performance.now();
  try {
    const session=await core(root+"/file-uploads","POST",{modelKey:env.MODEL_KEY,fieldKey:"attachments",name,contentType:MIME,size},201,"session");
    check(isId(session?.id,"upl")&&session.upload?.method==="PUT"&&session.upload.headers?.["content-type"]===MIME,"invalid_session");
    const url=signedUrl(session.upload.url,"uploads/native/"+env.SPACE_ID+"/"+session.id);
    stage="put";
    let tick=performance.now();
    const put=await fetchImpl(url,{method:"PUT",body:bytes,headers:{"content-type":MIME},redirect:"error",signal:AbortSignal.timeout(60000)});
    check(put.ok,"put_failed"); await put.arrayBuffer(); timings.putMs=round(performance.now()-tick);
    stage="finalize";
    const completed=await core(root+"/file-uploads/"+session.id+"/complete","POST",undefined,200,"finalize");
    check(isId(completed?.id,"fil"),"invalid_file"); file=completed.id;
    check(completed.size===size&&completed.contentType===MIME&&completed.name===name,"metadata_mismatch");
    timings.uploadE2eMs=round(performance.now()-start);
    stage="attach";
    const attached=await core(model,"POST",{name,attachments:[file]},201,"attach");
    check(/^rec_[A-Za-z0-9_-]+$/u.test(attached?.id??"")&&Number.isSafeInteger(attached.version)&&attached.version>0,"invalid_record");
    record=attached; check(attached.attachments?.length===1&&attached.attachments[0]===file,"attachment_mismatch");
    timings.saveE2eMs=round(performance.now()-start);
    stage="download";
    const download=await core(root+"/file-downloads","POST",{modelKey:env.MODEL_KEY,recordId:record.id,fieldKey:"attachments",fileId:file},200,"downloadSession");
    check(download?.id===file&&download.size===size&&download.contentType===MIME,"download_metadata_mismatch");
    tick=performance.now();
    const response=await fetchImpl(signedUrl(download.url,"files/"+env.SPACE_ID+"/"+file),{redirect:"error",signal:AbortSignal.timeout(60000)});
    check(response.ok&&response.headers.get("content-type")?.toLowerCase()===MIME,"download_failed");
    const received=await response.arrayBuffer();timings.downloadMs=round(performance.now()-tick);
    check(received.byteLength===size&&await digest(received)===hash,"integrity_mismatch");
  } catch { failure=stage; }
  finally {
    // Unknown outcomes are not retried. Exact fixture recovery is done by the runner.
    if(record)try{await core(model+"/"+record.id,"DELETE",{version:record.version},204);}catch{cleanupOk=false;}
    if(file)try{await core(root+"/files/"+file,"DELETE",undefined,204);}catch{cleanupOk=false;}
  }
  return {ok:!failure&&cleanupOk,size,stage:failure,cleanupOk,timings,completeRequestId,
    totalWithCleanupMs:round(performance.now()-start)};
}
export async function handleFileProbe(request,env,fetchImpl=fetch) {
  if(!configured(env))return json({error:"not_configured"},503);
  if(request.headers.get("x-lifespace-probe-token")!==env.PROBE_TOKEN)return json({error:"not_found"},404);
  const url=new URL(request.url);
  if(url.search)return json({error:"not_found"},404);
  if(request.method==="GET"&&url.pathname==="/health"){
    try{
      const res=await fetchImpl(CORE+"/api/v1/spaces/"+env.SPACE_ID+"/_discovery/models/"+env.MODEL_KEY,
        {headers:{authorization:"Bearer "+env.USER_BEARER},redirect:"error",signal:AbortSignal.timeout(20000)});
      const data=res.ok?(await res.json()).data:null;
      return json({ok:!!data?.fields?.some(f=>f.key==="attachments"&&f.type==="file_list"),probeIngressColo:request.cf?.colo??null});
    }catch{return json({ok:false},503);}
  }
  if(request.method!=="POST"||url.pathname!=="/sample")return json({error:"not_found"},404);
  let input;try{
    const reader=request.body?.getReader();let length=0,text="";const decoder=new TextDecoder();
    if(!reader)return json({error:"invalid_input"},400);
    try{while(true){const chunk=await reader.read();if(chunk.done)break;
      length+=chunk.value.byteLength;if(length>100){await reader.cancel();return json({error:"invalid_input"},400);}
      text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}finally{reader.releaseLock();}
    input=JSON.parse(text);
  }catch{return json({error:"invalid_input"},400);}
  if(!input||Object.keys(input).length!==1||!SIZES.includes(input.size))return json({error:"invalid_input"},400);
  try{return json({...await runFileSample(env,input.size,fetchImpl),probeIngressColo:request.cf?.colo??null});}
  catch{return json({error:"sample_failed"},500);}
}
// Workers supplies an ExecutionContext as the third argument, not fetch.
export default {fetch(request,env){return handleFileProbe(request,env);}};

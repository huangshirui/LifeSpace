// Staging-only test infrastructure; no LifeSpace credentials, D1 or product API.
export const PROTOCOL = "eventing-smoke-v1";
export const HOST = "eventing-smoke-staging.aisr.online";
const TTL_MS = 15 * 60 * 1000;
const MAX_BODY = 16384;
const encoder = new TextEncoder();
const sessionPattern = /^[a-f0-9]{32}$/u;
const secretPattern = /^[a-f0-9]{64}$/u;
const reference = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const bad = (status, code) => json({ code }, status);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
function equal(a,b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i=0;i<a.length;i++) diff |= a.charCodeAt(i)^b.charCodeAt(i);
  return diff === 0;
}
export async function mac(secret, text) {
  const key = await crypto.subtle.importKey("raw",encoder.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return hex(await crypto.subtle.sign("HMAC",key,encoder.encode(text)));
}
function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(k=>Object.hasOwn(value,k));
}
async function rawBody(request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8",{fatal:true});
  let size=0, result="";
  try {
    while (true) {
      const {done,value}=await reader.read();
      if (done) return result+decoder.decode();
      size+=value.byteLength;
      if (size>MAX_BODY) { await reader.cancel(); throw Error("body too large"); }
      result+=decoder.decode(value,{stream:true});
    }
  } finally { reader.releaseLock(); }
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== HOST || url.protocol !== "https:" || url.search) return bad(404,"route");
    if (!secretPattern.test(env.EVENTING_SMOKE_CONTROL_SECRET??"") || !env.SESSIONS) return bad(503,"unconfigured");
    const secret=env.EVENTING_SMOKE_CONTROL_SECRET;
    const control=url.pathname.startsWith("/control/");
    let id, action;
    if (control) {
      if (!equal(request.headers.get("authorization"),"Bearer "+secret)) return bad(401,"control_auth");
      if (url.pathname==="/control/ready" && request.method==="GET") return json({protocol:PROTOCOL,ready:true});
      id=url.pathname.split("/")[3];
      if (url.pathname!=="/control/sessions/"+id || !sessionPattern.test(id??"") || !["PUT","GET","DELETE"].includes(request.method)) return bad(404,"route");
      action="/session";
    } else {
      const match=/^\/webhook\/([a-f0-9]{32})\.([a-f0-9]{64})$/u.exec(url.pathname);
      if (!match || request.method!=="POST") return bad(404,"route");
      id=match[1];
      if (!equal(match[2],await mac(secret,"eventing-smoke-route-v1:"+id))) return bad(404,"route");
      action="/webhook";
    }
    // DO has no public route. Never forward CI control credential or path MAC.
    const headers=new Headers(request.headers);
    headers.delete("authorization");
    const stub=env.SESSIONS.get(env.SESSIONS.idFromName(id));
    return stub.fetch(new Request("https://session.invalid"+action,{
      method:request.method,headers,
      ...(["PUT","POST"].includes(request.method)?{body:request.body}:{}),
    }));
  },
};

export class EventingSmokeSession {
  constructor(ctx) { this.ctx=ctx; this.storage=ctx.storage; }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async()=>{
      const state=await this.storage.get("session");
      if (state && state.expiresAt>Date.now()) { await this.storage.setAlarm(state.expiresAt); return; }
      await this.storage.deleteAll();
      await this.storage.deleteAlarm();
    });
  }
  async fetch(request) {
    // Session-local operations serialize, including cleanup versus receipt write.
    return this.ctx.blockConcurrencyWhile(()=>this.handle(request));
  }
  async handle(request) {
    const path=new URL(request.url).pathname;
    let state=await this.storage.get("session");
    if (state && state.expiresAt<=Date.now()) {
      await this.storage.deleteAll(); await this.storage.deleteAlarm(); state=undefined;
    }
    if (path==="/session") {
      if (request.method==="DELETE") {
        await this.storage.deleteAll(); await this.storage.deleteAlarm();
        return new Response(null,{status:204});
      }
      if (request.method==="GET") return state
        ? json({protocol:PROTOCOL,expiresAt:state.expiresAt,testCount:state.testCount,receipts:state.receipts})
        : bad(404,"session_missing");
      if (request.method!=="PUT") return bad(404,"route");
      if (state) return bad(409,"session_exists");
      let input;
      try {input=JSON.parse(await rawBody(request));} catch {return bad(400,"input");}
      if (!exact(input,["signingSecret","spaceId","endpointId","subscriptionId","subscriberServicePrincipalId"])
        || !secretPattern.test(input.signingSecret??"")
        || !["spaceId","endpointId","subscriptionId","subscriberServicePrincipalId"].every(k=>reference(input[k]))) return bad(400,"input");
      state={...input,expiresAt:Date.now()+TTL_MS,testCount:0,receipts:[]};
      // Set alarm before persisting a secret; no unbounded session lifetime.
      await this.storage.setAlarm(state.expiresAt);
      await this.storage.put("session",state);
      return json({protocol:PROTOCOL,expiresAt:state.expiresAt},201);
    }
    if (path!=="/webhook" || request.method!=="POST") return bad(404,"route");
    if (!state) return bad(404,"session_missing");
    const timestamp=request.headers.get("x-lifespace-timestamp")??"";
    if (!/^\d{1,12}$/u.test(timestamp)||Math.abs(Math.floor(Date.now()/1000)-Number(timestamp))>300) return bad(401,"timestamp");
    let body;
    try {body=await rawBody(request);} catch {return bad(400,"body");}
    if (!equal(request.headers.get("x-lifespace-signature"),"v1="+await mac(state.signingSecret,timestamp+"."+body))) return bad(401,"signature");
    let payload;
    try {payload=JSON.parse(body);} catch {return bad(400,"body");}
    if (request.headers.get("x-lifespace-webhook-endpoint-id")!==state.endpointId || payload?.spaceId!==state.spaceId) return bad(400,"session_mismatch");
    if (request.headers.get("x-lifespace-test")==="true") {
      if (!exact(payload,["id","type","endpointId","spaceId","subscriberServicePrincipalId","occurredAt"])
        || payload.type!=="endpoint.test" || !reference(payload.id)
        || payload.endpointId!==state.endpointId || payload.subscriberServicePrincipalId!==state.subscriberServicePrincipalId
        || !Number.isFinite(Date.parse(payload.occurredAt))) return bad(400,"test_payload");
      if (state.testCount>=20) return bad(409,"receipt_limit");
      state.testCount++;
    } else {
      const deliveryId=request.headers.get("x-lifespace-delivery-id");
      if (!exact(payload,["id","type","spaceId","modelKey","recordId","recordVersion","changeId","occurredAt"])
        || payload.type!=="record.created" || payload.modelKey!=="event" || !reference(payload.id)||!reference(payload.recordId)
        || !Number.isInteger(payload.recordVersion)||payload.recordVersion<1
        || !reference(payload.changeId)||!payload.changeId.startsWith("chg_") || !Number.isFinite(Date.parse(payload.occurredAt))
        || request.headers.get("x-lifespace-event-id")!==payload.id || !reference(deliveryId)
        || request.headers.get("x-lifespace-subscription-id")!==state.subscriptionId) return bad(400,"event_payload");
      const receipt={deliveryId,eventId:payload.id,recordId:payload.recordId,recordVersion:payload.recordVersion,changeId:payload.changeId};
      const prior=state.receipts.find(r=>r.deliveryId===deliveryId);
      if (prior) {
        if (JSON.stringify(prior)!==JSON.stringify(receipt)) return bad(409,"receipt_conflict");
        return new Response(null,{status:204});
      }
      if (state.receipts.length>=20) return bad(409,"receipt_limit");
      state.receipts.push(receipt);
    }
    await this.storage.put("session",state);
    return new Response(null,{status:204});
  }
}

import { Hono } from "hono";
import { sign } from "hono/jwt";
import type { Bindings, Variables } from "./env";

type AppEnv={Bindings:Bindings;Variables:Variables};
const ok=<T>(data:T)=>({data});
const fail=(code:string,message:string,requestId:string)=>({error:{code,message,requestId}});
const id=(prefix:string)=>`${prefix}_${crypto.randomUUID().replaceAll("-","")}`;

export function createApp(){
  const app=new Hono<AppEnv>();
  app.use("*",async(c,next)=>{const requestId=c.req.header("x-request-id")?.trim()||crypto.randomUUID();c.set("requestId",requestId);await next();c.header("x-request-id",requestId);});
  app.get("/health",c=>c.json(ok({status:"ok"})));
  app.get("/api/v1/status",async c=>{const row=await c.env.DB.prepare(`SELECT value FROM schema_metadata WHERE key='schema_version'`).first<{value:string}>();if(!row)throw new Error("schema version metadata is missing");return c.json(ok({status:"ok",service:"identity",environment:c.env.ENVIRONMENT??"local",database:"available",schemaVersion:row.value,contractVersion:"0.1.0"}));});

  // Bootstrap endpoints are intentionally internal-only for Phase 1 staging/tests. They are not end-user signup APIs.
  app.post("/internal/v1/users",async c=>{const body=await c.req.json<{displayName?:string}>().catch(()=>({}));if(!body.displayName?.trim())return c.json(fail("VALIDATION_ERROR","displayName is required",c.get("requestId")),422);const userId=id("usr"),ts=new Date().toISOString();await c.env.DB.prepare(`INSERT INTO users(id,display_name,created_at,updated_at) VALUES(?,?,?,?)`).bind(userId,body.displayName.trim(),ts,ts).run();return c.json(ok({id:userId,displayName:body.displayName.trim()}),201);});
  app.post("/internal/v1/applications",async c=>{const body=await c.req.json<{id?:string;name?:string;clientType?:string;allowedScopes?:string[]}>().catch(()=>({}));if(!body.id||!body.name||!body.clientType||!["web","mini_program","service","device"].includes(body.clientType))return c.json(fail("VALIDATION_ERROR","id, name and valid clientType are required",c.get("requestId")),422);const ts=new Date().toISOString();await c.env.DB.prepare(`INSERT INTO applications(id,name,client_type,allowed_scopes,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(body.id,body.name,body.clientType,JSON.stringify(body.allowedScopes??[]),ts,ts).run();return c.json(ok({id:body.id,name:body.name}),201);});
  app.post("/internal/v1/tokens",async c=>{
    const body=await c.req.json<{subjectId?:string;clientId?:string;principalType?:string;scopes?:string[]}>().catch(()=>({}));
    if(!body.subjectId||!body.clientId||!body.principalType||!["user","service","device"].includes(body.principalType))return c.json(fail("VALIDATION_ERROR","subjectId, clientId and valid principalType are required",c.get("requestId")),422);
    const application=await c.env.DB.prepare(`SELECT allowed_scopes allowedScopes,status FROM applications WHERE id=?`).bind(body.clientId).first<{allowedScopes:string;status:string}>();
    if(!application||application.status!=="active")return c.json(fail("FORBIDDEN","Application is not active",c.get("requestId")),403);
    if(body.principalType==="user"){const user=await c.env.DB.prepare(`SELECT status FROM users WHERE id=?`).bind(body.subjectId).first<{status:string}>();if(!user||user.status!=="active")return c.json(fail("FORBIDDEN","User is not active",c.get("requestId")),403);}
    const allowed=JSON.parse(application.allowedScopes) as string[], requested=body.scopes??[];if(requested.some(s=>!allowed.includes(s)))return c.json(fail("FORBIDDEN","Requested scope is not allowed for this application",c.get("requestId")),403);
    if(!c.env.TOKEN_PRIVATE_KEY)return c.json(fail("IDENTITY_NOT_CONFIGURED","Token signing key is not configured",c.get("requestId")),500);
    const iat=Math.floor(Date.now()/1000),exp=iat+900,jti=id("tok");
    const token=await sign({iss:"lifespace-identity",aud:"lifespace-core",sub:body.subjectId,azp:body.clientId,principal_type:body.principalType,scope:requested.join(" "),iat,exp,jti},c.env.TOKEN_PRIVATE_KEY,"RS256");
    return c.json(ok({accessToken:token,tokenType:"Bearer",expiresIn:900,scope:requested.join(" ")}));
  });
  app.notFound(c=>c.json(fail("NOT_FOUND","Route not found",c.get("requestId")),404));
  app.onError((error,c)=>{console.error("Unhandled Identity API error",{requestId:c.get("requestId"),error});return c.json(fail("INTERNAL_ERROR","Internal server error",c.get("requestId")),500);});
  return app;
}

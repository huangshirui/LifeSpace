import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { configuredAccessIssuer } from "./access-auth";

type AppEnv = { Bindings: Bindings; Variables: Variables };
export type WebLoginEmail = { user_id: string; application_id: string; issuer: string; email: string; version: number };
const fail = (c: Context<AppEnv>, code: string, message: string) => ({error:{code,message,requestId:c.get("requestId")}});

// Deliberately bounded ASCII mailbox syntax, not an ownership verification claim.
export function normalizeLoginEmail(value: unknown): string | null {
  if(typeof value !== "string") return null;
  const email=value.trim().toLowerCase();
  if(email.length>254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) return null;
  const local=email.split("@")[0];
  if(local.length>64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return email;
}

export async function readWebLoginEmail(db: D1Database, userId: string, applicationId: string) {
  return db.prepare("SELECT user_id,application_id,issuer,email,version FROM web_login_emails WHERE user_id=? AND application_id=?")
    .bind(userId,applicationId).first<WebLoginEmail>();
}

export function registerWebLoginEmailRoutes(app: Hono<AppEnv>) {
  app.get("/api/v1/me/web-login", async c=>{
    const principal=c.get("principal");
    if(!principal.scopes.includes("profile:read")) return c.json(fail(c,"FORBIDDEN","profile:read is required"),403);
    const row=await readWebLoginEmail(c.env.DB,principal.id,principal.clientId);
    const linked=await c.env.DB.prepare("SELECT id FROM access_principals WHERE user_id=? AND status='active' LIMIT 1").bind(principal.id).first();
    c.header("cache-control","no-store");
    return c.json({data:{email:row?.email??null,version:row?.version??0,linked:Boolean(row||linked)}});
  });
  app.patch("/api/v1/me/web-login",async c=>{
    const principal=c.get("principal");
    if(!principal.scopes.includes("profile:write")) return c.json(fail(c,"FORBIDDEN","profile:write is required"),403);
    const input=await c.req.json<Record<string,unknown>>().catch(()=>null);
    if(!input || typeof input!=="object" || Array.isArray(input) || Object.keys(input).some(k=>!["email","version"].includes(k))) return c.json(fail(c,"INVALID_REQUEST","Only email and version are accepted"),400);
    const email=normalizeLoginEmail(input.email);
    if(!email || !Number.isSafeInteger(input.version) || (input.version as number)<0) return c.json(fail(c,"VALIDATION_ERROR","A valid email and current non-negative version are required"),422);
    let issuer:string;
    try { issuer=configuredAccessIssuer(c.env.ACCESS_TEAM_DOMAIN); }
    catch { return c.json(fail(c,"ACCESS_NOT_CONFIGURED","Web login is unavailable"),503); }
    // This endpoint records explicit user consent to grant this mailbox access.
    // It never marks mailbox ownership verified or merges an existing principal.
    const conflict=await c.env.DB.prepare("SELECT id FROM access_principals WHERE issuer=? AND lower(email_snapshot)=? AND user_id<>? AND status='active' LIMIT 1")
      .bind(issuer,email,principal.id).first();
    if(conflict) return c.json(fail(c,"EMAIL_UNAVAILABLE","This email cannot be authorized for this account"),409);
    const version=(input.version as number)+1, now=new Date().toISOString();
    try {
      const results=await c.env.DB.batch([
        input.version===0
          ? c.env.DB.prepare("INSERT INTO web_login_emails(user_id,application_id,issuer,email,version,updated_at) VALUES(?,?,?,?,1,?) ON CONFLICT(user_id,application_id) DO NOTHING")
            .bind(principal.id,principal.clientId,issuer,email,now)
          : c.env.DB.prepare("UPDATE web_login_emails SET issuer=?,email=?,version=version+1,updated_at=? WHERE user_id=? AND application_id=? AND version=?")
            .bind(issuer,email,now,principal.id,principal.clientId,input.version),
        c.env.DB.prepare(`INSERT INTO web_login_email_audit(id,user_id,application_id,version,request_id,created_at)
          SELECT ?,?,?,?,?,? WHERE changes()=1`)
          .bind(crypto.randomUUID(),principal.id,principal.clientId,version,c.get("requestId"),now),
      ]);
      if(results[0].meta.changes!==1) return c.json(fail(c,"EMAIL_VERSION_CONFLICT","Email changed; reload before saving"),409);
    }catch(error) {
      const message=String(error instanceof Error ? error.message : error);
      if(!message.includes("UNIQUE constraint failed")) throw error;
      return c.json(fail(c,"EMAIL_UNAVAILABLE","This email cannot be authorized for this account"),409);
    }
    c.header("cache-control","no-store");
    return c.json({data:{email,version,linked:true}});
  });
}

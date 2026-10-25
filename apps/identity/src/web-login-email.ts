import type { Context,Hono } from 'hono';
import type { Bindings,Variables } from './env';
import { configuredAccessIssuer } from './access-auth';
import { accessLinkState,claimLinkRevision,linkAudit } from './access-account-link';
type AppEnv={Bindings:Bindings;Variables:Variables};
const fail=(c:Context<AppEnv>,code:string,message:string)=>({error:{code,message,requestId:c.get('requestId')}});

// Declared mailbox syntax; only Access can prove ownership at login.
export function normalizeLoginEmail(value:unknown):string|null {
 if(typeof value!=='string')return null;
 const email=value.trim().toLowerCase();
 if(email.length>254||!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email))return null;
 const local=email.split('@')[0];return local.length>64||local.startsWith('.')||local.endsWith('.')||local.includes('..')?null:email;
}

export function registerWebLoginEmailRoutes(app:Hono<AppEnv>) {
 app.get('/api/v1/me/web-login',async c=>{
  const principal=c.get('principal');
  if(!principal.scopes.includes('profile:read'))return c.json(fail(c,'FORBIDDEN','profile:read is required'),403);
  let issuer:string;try{issuer=configuredAccessIssuer(c.env.ACCESS_TEAM_DOMAIN);}catch{return c.json(fail(c,'ACCESS_NOT_CONFIGURED','Web login is unavailable'),503);}
  const {link:row,version}=await accessLinkState(c.env.DB,principal.id,principal.clientId,issuer);
  c.header('cache-control','no-store');
  return c.json({data:{email:row?.email_snapshot??null,version,linked:Boolean(row?.subject),status:row?(row.subject?'linked':'pending'):'unlinked'}});
 });
 app.patch('/api/v1/me/web-login',async c=>{
  const principal=c.get('principal'),db=c.env.DB;
  c.header('cache-control','no-store');
  if(!principal.scopes.includes('profile:write'))return c.json(fail(c,'FORBIDDEN','profile:write is required'),403);
  const input=await c.req.json<Record<string,unknown>>().catch(()=>null);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['email','version'].includes(k)))return c.json(fail(c,'INVALID_REQUEST','Only email and version are accepted'),400);
  const email=normalizeLoginEmail(input.email);
  if(!email||!Number.isSafeInteger(input.version)||(input.version as number)<0)return c.json(fail(c,'VALIDATION_ERROR','A valid email and current version are required'),422);
  let issuer:string;try{issuer=configuredAccessIssuer(c.env.ACCESS_TEAM_DOMAIN);}catch{return c.json(fail(c,'ACCESS_NOT_CONFIGURED','Web login is unavailable'),503);}
  const {link:row,version}=await accessLinkState(db,principal.id,principal.clientId,issuer);
  if(version!==input.version)return c.json(fail(c,'EMAIL_VERSION_CONFLICT','Account link changed; reload before saving'),409);
  if(row?.email_snapshot===email)return c.json({data:{email,version,linked:Boolean(row.subject),status:row.subject?'linked':'pending'}});
  const operationId=crypto.randomUUID(),now=new Date().toISOString();
  try {
   const results=await db.batch([
    claimLinkRevision(db,principal.id,version,operationId),
    db.prepare(`UPDATE access_principals SET status='disabled',updated_at=? WHERE id=? AND user_id=?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`).bind(now,row?.id??'',principal.id,principal.id,operationId),
    db.prepare(`INSERT INTO access_principals(id,issuer,subject,user_id,email_snapshot,pending_application_id,status,linked_at,created_at,updated_at)
      SELECT ?,?,NULL,id,?,?,'active',?,?,? FROM users WHERE id=? AND access_link_operation_id=?`)
      .bind('acp_'+crypto.randomUUID().replaceAll('-',''),issuer,email,principal.clientId,now,now,now,principal.id,operationId),
    linkAudit(db,principal.id,principal.clientId,operationId,c.get('requestId'),now),
   ]);
   if(results[0].meta.changes!==1)return c.json(fail(c,'EMAIL_VERSION_CONFLICT','Account link changed; reload before saving'),409);
  }catch(error){if(!/UNIQUE constraint|ACCESS_EMAIL_CONFLICT/.test(String(error)))throw error;return c.json(fail(c,'EMAIL_UNAVAILABLE','This email is linked to another account'),409);}
  c.header('cache-control','no-store');
  return c.json({data:{email,version:version+1,linked:false,status:'pending'}});
 });
}

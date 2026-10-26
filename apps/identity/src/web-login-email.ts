import type { Context,Hono } from 'hono';
import type { Bindings,Variables } from './env';
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

type LoginEmailState={email:string|null;version:number;linked:boolean};
const toDto=(state:LoginEmailState)=>({...state,status:state.email?(state.linked?'linked':'pending'):'unlinked'});
const conflict=(c:Context<AppEnv>)=>c.json(fail(c,'EMAIL_VERSION_CONFLICT','Account link changed; reload before saving'),409);
const emailConflict=(c:Context<AppEnv>)=>c.json(fail(c,'EMAIL_ALREADY_LINKED','This email is linked to another LifeSpace user'),409);
const isEmailConflict=(error:unknown)=>/UNIQUE constraint|ACCESS_EMAIL_CONFLICT/.test(String(error));

export function registerWebLoginEmailRoutes(app:Hono<AppEnv>) {
 app.get('/api/v1/me/web-login',async c=>{
  const principal=c.get('principal');
  if(!principal.scopes.includes('profile:read'))return c.json(fail(c,'FORBIDDEN','profile:read is required'),403);
  const state=await accessLinkState(c.env.DB,principal.id);
  c.header('cache-control','no-store');
  return c.json({data:toDto(state)});
 });

 app.patch('/api/v1/me/web-login',async c=>{
  const principal=c.get('principal'),db=c.env.DB;
  c.header('cache-control','no-store');
  if(!principal.scopes.includes('profile:write'))return c.json(fail(c,'FORBIDDEN','profile:write is required'),403);
  const input=await c.req.json<Record<string,unknown>>().catch(()=>null);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['email','version'].includes(k)))
    return c.json(fail(c,'INVALID_REQUEST','Only email and version are accepted'),400);
  const email=normalizeLoginEmail(input.email);
  if(!email||!Number.isSafeInteger(input.version)||(input.version as number)<0)
    return c.json(fail(c,'VALIDATION_ERROR','A valid email and current version are required'),422);
  const state=await accessLinkState(db,principal.id);
  if(state.version!==input.version)return conflict(c);
  if(state.email===email)return c.json({data:toDto(state)});
  const operationId=crypto.randomUUID(),now=new Date().toISOString();
  try{
   const results=await db.batch([
    claimLinkRevision(db,principal.id,state.version,operationId),
    // Revoke ONLY automatically email-linked Access principals for the old
    // mailbox. Code-linked and unrelated principals remain independently valid.
    db.prepare(`UPDATE access_principals SET status='disabled',updated_at=?
      WHERE user_id=? AND linked_via_email=1 AND lower(trim(email_snapshot))=?
      AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`)
      .bind(now,principal.id,state.email??'',principal.id,operationId),
    db.prepare(`INSERT INTO user_login_emails(user_id,email,created_at,updated_at)
      SELECT id,?,?,? FROM users WHERE id=? AND access_link_operation_id=?
      ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,updated_at=excluded.updated_at`)
      .bind(email,now,now,principal.id,operationId),
    linkAudit(db,principal.id,principal.clientId,operationId,c.get('requestId'),now),
   ]);
   if(results[0].meta.changes!==1)return conflict(c);
  }catch(error){if(!isEmailConflict(error))throw error;return emailConflict(c);}
  return c.json({data:{email,version:state.version+1,linked:false,status:'pending'}});
 });

 app.delete('/api/v1/me/web-login',async c=>{
  const principal=c.get('principal'),db=c.env.DB;
  c.header('cache-control','no-store');
  if(!principal.scopes.includes('profile:write'))return c.json(fail(c,'FORBIDDEN','profile:write is required'),403);
  const input=await c.req.json<Record<string,unknown>>().catch(()=>null);
  if(!input||Object.keys(input).length!==1||!Number.isSafeInteger(input.version)||(input.version as number)<0)
    return c.json(fail(c,'VALIDATION_ERROR','Current version is required'),422);
  const state=await accessLinkState(db,principal.id);
  if(state.version!==input.version)return conflict(c);
  if(!state.email)return c.json({data:toDto(state)});
  const operationId=crypto.randomUUID(),now=new Date().toISOString();
  const results=await db.batch([
   claimLinkRevision(db,principal.id,state.version,operationId),
   db.prepare(`UPDATE access_principals SET status='disabled',updated_at=?
     WHERE user_id=? AND linked_via_email=1 AND lower(trim(email_snapshot))=?
     AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`)
      .bind(now,principal.id,state.email,principal.id,operationId),
   db.prepare(`DELETE FROM user_login_emails WHERE user_id=?
     AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`)
      .bind(principal.id,principal.id,operationId),
   linkAudit(db,principal.id,principal.clientId,operationId,c.get('requestId'),now),
  ]);
  if(results[0].meta.changes!==1)return conflict(c);
  return c.json({data:{email:null,version:state.version+1,linked:false,status:'unlinked'}});
 });
}

/** One Access identity relation, completed by either pre-link or challenge proof. */
export type AccessLink = { id:string; issuer:string; subject:string|null; user_id:string; email_snapshot:string|null; pending_application_id:string|null };

export async function currentAccessLink(db:D1Database,userId:string,applicationId:string,issuer:string) {
  return db.prepare(`SELECT id,issuer,subject,user_id,email_snapshot,pending_application_id FROM access_principals
    WHERE user_id=? AND issuer=? AND status='active' AND (subject IS NOT NULL OR pending_application_id=?)
    ORDER BY (subject IS NULL) DESC,link_version DESC,linked_at DESC,id DESC LIMIT 1`).bind(userId,issuer,applicationId).first<AccessLink>();
}

// One LifeSpace-global mailbox reservation per user, independent of Application.
// Read email/version and linked state in one snapshot.
export async function accessLinkState(db:D1Database,userId:string) {
 const row=await db.prepare(`SELECT u.access_link_version version,e.email,
   EXISTS(SELECT 1 FROM access_principals p WHERE p.user_id=u.id AND p.status='active'
    AND p.subject IS NOT NULL AND lower(trim(p.email_snapshot))=e.email) linked
   FROM users u LEFT JOIN user_login_emails e ON e.user_id=u.id
   WHERE u.id=?`).bind(userId).first<{version:number;email:string|null;linked:number}>();
 if(!row)throw new Error('Authenticated user unavailable');
 return {email:row.email??null,linked:Boolean(row.email&&row.linked),version:row.version};
}

export async function linkVersion(db:D1Database,userId:string) {
  const row=await db.prepare('SELECT access_link_version version FROM users WHERE id=?').bind(userId).first<{version:number}>();
  if(!row)throw new Error('Authenticated user unavailable');
  return row.version;
}

export function claimLinkRevision(db:D1Database,userId:string,version:number,operationId:string) {
  return db.prepare(`UPDATE users SET access_link_version=access_link_version+1,access_link_operation_id=?
    WHERE id=? AND access_link_version=? AND status='active'`).bind(operationId,userId,version);
}

export function linkAudit(db:D1Database,userId:string,appId:string,operationId:string,requestId:string,now:string) {
  return db.prepare(`INSERT INTO access_link_audit(id,user_id,application_id,version,request_id,created_at)
    SELECT ?,id,?,access_link_version,?,? FROM users WHERE id=? AND access_link_operation_id=?`)
    .bind(crypto.randomUUID(),appId,requestId,now,userId,operationId);
}

// Both entry points use this exact statement to materialize the verified subject.
// A pre-linked row is completed in place; absent pre-link means normal code linking.
export function completeAccessLink(db:D1Database,input:{id:string;pendingId?:string;existingId?:string;issuer:string;subject:string;email:string|null;userId:string;operationId:string;now:string;viaEmail?:boolean}) {
  const {id,pendingId,existingId,issuer,subject,email,userId,operationId,now,viaEmail=false}=input;
  if(existingId)return db.prepare(`UPDATE access_principals SET status='active',link_version=(SELECT access_link_version FROM users WHERE id=access_principals.user_id),email_snapshot=?,last_seen_at=?,updated_at=?
    WHERE id=? AND user_id=? AND subject=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`)
    .bind(email,now,now,existingId,userId,subject,userId,operationId);
  if(pendingId)return db.prepare(`UPDATE access_principals SET subject=?,link_version=(SELECT access_link_version FROM users WHERE id=access_principals.user_id),email_snapshot=?,pending_application_id=NULL,linked_at=?,last_seen_at=?,updated_at=?
    WHERE id=? AND user_id=? AND subject IS NULL AND status='active'
    AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`)
    .bind(subject,email,now,now,now,pendingId,userId,userId,operationId);
  return db.prepare(`INSERT INTO access_principals(id,issuer,subject,user_id,email_snapshot,link_version,status,linked_at,last_seen_at,created_at,updated_at,linked_via_email)
    SELECT ?,?,?,id,?,access_link_version,'active',?,?,?,?,? FROM users WHERE id=? AND access_link_operation_id=?`)
    .bind(id,issuer,subject,email,now,now,now,now,viaEmail?1:0,userId,operationId);
}

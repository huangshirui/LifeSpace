import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
const migrations=new URL('../../apps/identity/migrations/',import.meta.url);
const sql=name=>fs.readFileSync(new URL(name,migrations),'utf8');
function database(){const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT DEFAULT 'active');CREATE TABLE applications(id TEXT PRIMARY KEY);CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT);INSERT INTO schema_metadata VALUES('schema_version','4');INSERT INTO users(id) VALUES('usr_old'),('usr_pending'),('usr_other');INSERT INTO applications VALUES('app_test');`);db.exec(sql('0005_cloudflare_access_identity.sql'));db.exec(sql('0012_web_login_email_authorization.sql'));db.exec(`INSERT INTO access_principals(id,issuer,subject,user_id,email_snapshot,linked_at,created_at,updated_at) VALUES('acp_old','issuer','verified-subject','usr_old','old@example.com','now','now','now');`);return db;}
test('forward migration preserves verified identities and completes old declarations in one table',()=>{
 const db=database();db.exec(`INSERT INTO web_login_emails VALUES('usr_old','app_test','issuer','old@example.com',3,'now');INSERT INTO web_login_emails VALUES('usr_pending','app_test','issuer','pending@example.com',2,'now');INSERT INTO web_login_email_audit VALUES('audit','usr_pending','app_test',2,'req','now');`);
 db.exec(sql('0013_unified_access_links.sql'));
 assert.equal(db.prepare("SELECT count(*) n FROM access_principals WHERE subject='verified-subject' AND id='acp_old'").get().n,1);
 assert.equal(db.prepare("SELECT count(*) n FROM access_principals WHERE user_id='usr_old'").get().n,1);
 const pending=db.prepare("SELECT subject,email_snapshot,pending_application_id FROM access_principals WHERE user_id='usr_pending'").get();assert.deepEqual({...pending},{subject:null,email_snapshot:'pending@example.com',pending_application_id:'app_test'});
 assert.equal(db.prepare("SELECT access_link_version FROM users WHERE id='usr_pending'").get().access_link_version,2);
 assert.equal(db.prepare("SELECT count(*) n FROM access_link_audit").get().n,1);
 assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='web_login_emails'").get(),undefined);db.close();
});
test('conflicting legacy declaration aborts transaction without merging users or changing schema',()=>{
 const db=database();db.exec("INSERT INTO web_login_emails VALUES('usr_other','app_test','issuer','old@example.com',1,'now')");
 db.exec('BEGIN');assert.throws(()=>db.exec(sql('0013_unified_access_links.sql')),/ACCESS_EMAIL_CONFLICT/);db.exec('ROLLBACK');
 assert.equal(db.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").get().value,'12');assert.equal(db.prepare("SELECT user_id FROM access_principals WHERE id='acp_old'").get().user_id,'usr_old');db.close();
});

test('admin discovery and inspector exclude pending identity declarations',()=>{
 const resolver=fs.readFileSync(new URL('./resolve-production-console-admin.mjs',import.meta.url),'utf8');
 const inspector=fs.readFileSync(new URL('../../apps/identity/src/platform-inspector.ts',import.meta.url),'utf8');
 assert.match(resolver,/ap\.subject IS NOT NULL/);assert.match(inspector,/user_id=\? AND subject IS NOT NULL/);
});

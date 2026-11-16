import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { cleanupFileUploads } from "../src/file-routes";
import { countingDatabase, type DatabaseCost } from "./support/counting-database";

describe("File cleanup pending-only D1 budget (#593)", () => {
  it("excludes retained history and future uploads, preserves stale thresholds and uses indexed bounded selection", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const space = "spc_" + crypto.randomUUID().replaceAll("-", "");
    const now = new Date().toISOString();
    const past = "2000-01-01T00:00:00.000Z";
    const future = "2099-01-01T00:00:00.000Z";
    const uid = (i: number) => "upl_" + i.toString(16).padStart(32, "0");
    const fid = (i: number) => "fil_" + i.toString(16).padStart(32, "0");
    await db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(space, "Cleanup cost fixture", "usr_cleanup", now, now, "UTC").run();
    const seq = "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<1000)";
    await db.batch([
      db.prepare(`${seq} INSERT INTO file_upload_sessions(
        id,space_id,model_key,field_key,destination,object_key,name,content_type,expected_size,status,
        application_id,principal_type,principal_id,actor_type,actor_id,expires_at,cleaned_at,created_at)
        SELECT 'upl_'||printf('%032x',i),?,'task','attachment','external','history/upload/'||i,'file','text/plain',1,
          'completed','app_cleanup','user','usr_cleanup','user','usr_cleanup',?,?,? FROM seq`)
        .bind(space,past,past,past),
      db.prepare(`${seq} INSERT INTO files(
        id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,
        actor_type,actor_id,created_at,deletion_requested_at,deleted_at)
        SELECT 'fil_'||printf('%032x',i),?,'file','text/plain',1,'history/file/'||i,'deleted','app_cleanup',
          'user','usr_cleanup','user','usr_cleanup',?,?,? FROM seq`).bind(space,past,past,past),
      db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1001 UNION ALL SELECT i+1 FROM seq WHERE i<1200)
        INSERT INTO file_upload_sessions(
          id,space_id,model_key,field_key,destination,object_key,name,content_type,expected_size,status,
          application_id,principal_type,principal_id,actor_type,actor_id,expires_at,created_at)
        SELECT 'upl_'||printf('%032x',i),?,'task','attachment','external','future/upload/'||i,'file','text/plain',1,
          'pending','app_cleanup','user','usr_cleanup','user','usr_cleanup',?,? FROM seq`).bind(space,future,now),
    ]);
    const sessions = [
      [2001,"pending",past], [2002,"executing",past], [2003,"unknown",past],
      [2004,"failed",future], [2005,"completed",future],
      [2006,"executing",now], [2007,"unknown",now], [2008,"pending",future], [2009,"expired",past],
    ] as const;
    await db.batch(sessions.map(([i,status,expiry]) => db.prepare(`INSERT INTO file_upload_sessions(
      id,space_id,model_key,field_key,destination,object_key,name,content_type,expected_size,status,
      application_id,principal_type,principal_id,actor_type,actor_id,expires_at,created_at)
      VALUES(?,?,'task','attachment','external',?,'file','text/plain',1,?,'app_cleanup','user',
      'usr_cleanup','user','usr_cleanup',?,?)`).bind(uid(i),space,"due/upload/"+i,status,expiry,now)));
    await db.batch([2001,2002,2003].map(i => db.prepare(`INSERT INTO files(
      id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,
      actor_type,actor_id,created_at,deletion_requested_at)
      VALUES(?,?,'file','text/plain',1,?,?,'app_cleanup','user','usr_cleanup','user','usr_cleanup',?,?)`)
      .bind(fid(i),space,"due/file/"+i,i===2003?"ready":"deleting",now,now)));

    const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] };
    const removed: string[] = [];
    const bindings = { DB: countingDatabase(db,cost), ASSETS: { delete: async (key: string) => { removed.push(key); } } } as unknown as Bindings;
    await cleanupFileUploads(bindings);
    expect(new Set(removed)).toEqual(new Set([
      "due/upload/2001","due/upload/2002","due/upload/2003","due/upload/2004","due/upload/2005",
      "due/file/2001","due/file/2002",
    ]));
    expect(cost.rowsRead).toBeGreaterThan(0);
    expect(cost.rowsRead).toBeLessThan(150);
    const uploadSQL = cost.sql.find(sql => sql.startsWith("SELECT * FROM file_upload_sessions"))!;
    const deleteSQL = cost.sql.find(sql => sql.startsWith("SELECT id,object_key FROM files"))!;
    expect(uploadSQL).toBeTruthy(); expect(deleteSQL).toBeTruthy();
    const uploadPlan = await db.prepare("EXPLAIN QUERY PLAN "+uploadSQL)
      .bind(now, new Date(Date.now()-86400000).toISOString(), new Date(Date.now()-7*86400000).toISOString())
      .all<{detail:string}>();
    const plan = uploadPlan.results.map(x=>x.detail).join("\n");
    expect(plan).toContain("idx_file_upload_sessions_due");
    expect(plan).toContain("idx_file_upload_sessions_terminal");
    expect(plan).not.toMatch(/SCAN file_upload_sessions(?! USING INDEX)/u);
    const deletionPlan = await db.prepare("EXPLAIN QUERY PLAN "+deleteSQL).all<{detail:string}>();
    expect(deletionPlan.results.map(x=>x.detail).join("\n")).toContain("idx_files_deletion_due");
    expect(await db.prepare("SELECT status,cleaned_at FROM file_upload_sessions WHERE id=?").bind(uid(2001)).first()).toMatchObject({status:"expired",cleaned_at:expect.any(String)});
    expect(await db.prepare("SELECT status,cleaned_at FROM file_upload_sessions WHERE id=?").bind(uid(2002)).first()).toMatchObject({status:"unknown",cleaned_at:expect.any(String)});
    expect(await db.prepare("SELECT status,cleaned_at FROM file_upload_sessions WHERE id=?").bind(uid(2006)).first()).toMatchObject({status:"executing",cleaned_at:null});
    expect(await db.prepare("SELECT status FROM files WHERE id=?").bind(fid(2001)).first()).toMatchObject({status:"deleted"});
    expect(await db.prepare("SELECT status FROM files WHERE id=?").bind(fid(2003)).first()).toMatchObject({status:"ready"});
    removed.length = 0; cost.rowsRead=0; cost.roundTrips=0; cost.sql=[];
    await cleanupFileUploads(bindings);
    expect(removed).toEqual([]);
    expect(cost.roundTrips).toBe(2);
    expect(cost.rowsRead).toBeLessThanOrEqual(20);
  }, 20000);
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { validateFileProjectionGroups } from "../src/generic-resource";

type TestEnv = { DB: D1Database };
function bindings(): Bindings { return { DB: (env as unknown as TestEnv).DB } as Bindings; }

describe("Native File reference integrity", () => {
  it("accepts only ready Files from the same Space", async () => {
    const db=(env as unknown as TestEnv).DB; const suffix=crypto.randomUUID().replaceAll("-","");
    const space=`spc_${suffix}`; const other=`spc_${crypto.randomUUID().replaceAll("-","")}`; const now=new Date().toISOString();
    const good=`fil_${crypto.randomUUID().replaceAll("-","")}`; const foreign=`fil_${crypto.randomUUID().replaceAll("-","")}`;
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(space,"Files","usr_test",now,now,"UTC"),
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(other,"Other","usr_test",now,now,"UTC"),
      db.prepare("INSERT INTO files(id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(good,space,"a.pdf","application/pdf",10,`files/${good}`,"ready","app_test","user","usr_test","user","usr_test",now),
      db.prepare("INSERT INTO files(id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(foreign,other,"b.pdf","application/pdf",10,`files/${foreign}`,"ready","app_test","user","usr_test","user","usr_test",now),
    ]);
    const errors=await validateFileProjectionGroups(bindings(),space,[
      [{fieldKey:"attachment",fileId:good,ordinal:0}],
      [{fieldKey:"attachment",fileId:foreign,ordinal:0}],
    ]);
    expect(errors[0]).toBeNull();
    expect(errors[1]?.code).toBe("INVALID_FILE_REFERENCE");
  });
  it("prevents attaching a File after its deletion state is claimed", async () => {
    const db=(env as unknown as TestEnv).DB;
    const suffix=crypto.randomUUID().replaceAll("-","");
    const space=`spc_${suffix}`; const id=`fil_${crypto.randomUUID().replaceAll("-","")}`;
    const now=new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(space,"File lifecycle","usr_test",now,now,"UTC"),
      db.prepare("INSERT INTO files(id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id,space,"test.txt","text/plain",5,`files/${space}/${id}`,"ready","app_test","user","usr_test","user","usr_test",now),
    ]);
    const before=await validateFileProjectionGroups(bindings(),space,[[{fieldKey:"document",fileId:id,ordinal:0}]]);
    expect(before[0]).toBeNull();
    const claim=await db.prepare(`UPDATE files SET status='deleting',deletion_requested_at=?
      WHERE id=? AND status='ready' AND NOT EXISTS(SELECT 1 FROM resource_file_links WHERE file_id=?)`)
      .bind(now,id,id).run();
    expect(claim.meta.changes).toBe(1);
    const after=await validateFileProjectionGroups(bindings(),space,[[{fieldKey:"document",fileId:id,ordinal:0}]]);
    expect(after[0]?.code).toBe("INVALID_FILE_REFERENCE");
    await db.prepare("UPDATE files SET status='deleted',deleted_at=? WHERE id=? AND status='deleting'").bind(now,id).run();
    const row=await db.prepare("SELECT status,deleted_at FROM files WHERE id=?").bind(id).first<{status:string;deleted_at:string}>();
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).toBe(now);
  });

});

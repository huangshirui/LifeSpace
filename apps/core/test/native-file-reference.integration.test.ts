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
});

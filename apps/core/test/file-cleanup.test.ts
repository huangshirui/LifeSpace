import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { cleanupFileUploads, type UploadSessionRow } from "../src/file-routes";

function runCleanup(status: UploadSessionRow["status"], published: boolean) {
  const deleted: string[] = [];
  const row = {
    id: "upl_" + "a".repeat(32),
    space_id: "spc_test",
    destination: "native",
    file_id: "fil_" + "b".repeat(32),
    object_key: "uploads/native/spc_test/upl_" + "a".repeat(32),
    status,
  } as UploadSessionRow;
  const db = {
    prepare(sql: string) {
      const all = async () => {
        if (sql.startsWith("SELECT * FROM file_upload_sessions")) return { results: [row] };
        if (sql.startsWith("SELECT id,object_key FROM files WHERE status='deleting'")) return { results: [] };
        throw new Error("Unexpected query");
      };
      return {
        all,
        bind(..._params: unknown[]) {
          return {
            all,
            async first() {
              if (!sql.startsWith("SELECT id FROM files")) throw new Error("Unexpected lookup");
              return published ? { id: row.file_id } : null;
            },
            async run() {
              if (!sql.startsWith("UPDATE file_upload_sessions")) throw new Error("Unexpected mutation");
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const env = {
    DB: db,
    ASSETS: { delete: async (key: string) => { deleted.push(key); } },
  } as unknown as Bindings;
  return { deleted, task: cleanupFileUploads(env), row };
}

describe("File upload cleanup safety", () => {
  it("deletes only staging bytes for a completed Native upload", async () => {
    const result = runCleanup("completed", true);
    await result.task;
    expect(result.deleted).toEqual([result.row.object_key]);
  });

  it("preserves a published File even when its session was marked failed", async () => {
    const result = runCleanup("failed", true);
    await result.task;
    expect(result.deleted).toEqual([result.row.object_key]);
  });

  it("removes an orphan promoted object after an uncommitted Native upload", async () => {
    const result = runCleanup("failed", false);
    await result.task;
    expect(result.deleted).toEqual([
      "files/spc_test/" + result.row.file_id,
      result.row.object_key,
    ]);
  });
});

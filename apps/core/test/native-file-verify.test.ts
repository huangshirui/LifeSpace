import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { Hono, type Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Bindings, Principal, Variables } from "../src/env";
import { ApiError } from "../src/http";
import { publishModelDefinition } from "../src/model-registry";
import { registerFileRoutes, scheduleCompletedNativeUploadCleanup, verifyStagedUpload, type UploadSessionRow } from "../src/file-routes";

const row = {
  id: "upl_" + "a".repeat(32),
  destination: "native",
  object_key: "uploads/native/spc_synthetic/upl_" + "a".repeat(32),
  expected_size: 18,
  content_type: "application/pdf",
} as UploadSessionRow;
const external = { ...row, destination: "external", object_key: "uploads/external/spc_synthetic/" + row.id } as const;

function mockR2(value: object | null) {
  const head = vi.fn(async (_key: string) => value);
  const get = vi.fn(async (_key: string) => value);
  return { env: { ASSETS: { get, head } } as unknown as Bindings, head, get };
}

describe("File staging verification", () => {
  it("uses exactly one Native GET and promotes the verified snapshot, without a staging HEAD", async () => {
    const obj = { size: 18, httpMetadata: { contentType: "application/pdf" }, body: new ReadableStream() };
    const r2 = mockR2(obj);
    expect(await verifyStagedUpload(r2.env, row)).toBe(obj);
    expect(r2.get).toHaveBeenCalledExactlyOnceWith(row.object_key);
    expect(r2.head).not.toHaveBeenCalled();
  });

  it("uses only a metadata HEAD for External upload", async () => {
    const r2 = mockR2({ size: 18, httpMetadata: { contentType: "application/pdf" } });
    expect(await verifyStagedUpload(r2.env, external)).toBeNull();
    expect(r2.head).toHaveBeenCalledExactlyOnceWith(external.object_key);
    expect(r2.get).not.toHaveBeenCalled();
  });

  for (const session of [row, external]) {
    it(`rejects missing, size and MIME mismatches for ${session.destination}`, async () => {
      for (const metadata of [
        null,
        { size: 17, httpMetadata: { contentType: "application/pdf" } },
        { size: 18, httpMetadata: { contentType: "image/png" } },
        { size: 18, httpMetadata: {} },
      ]) {
        const cancel = vi.fn(async () => undefined);
        const r2 = mockR2(metadata && { ...metadata, body: { cancel } });
        await expect(verifyStagedUpload(r2.env, session)).rejects.toMatchObject({
          status: 409,
          code: metadata ? "UPLOAD_MISMATCH" : "UPLOAD_INCOMPLETE",
        });
        expect(r2.get).toHaveBeenCalledTimes(session.destination === "native" ? 1 : 0);
        expect(r2.head).toHaveBeenCalledTimes(session.destination === "external" ? 1 : 0);
        expect(cancel).toHaveBeenCalledTimes(metadata && session.destination === "native" ? 1 : 0);
      }
    });
  }
});

type TestContext = Context<{ Bindings: Bindings; Variables: Variables }>;
function cleanupFixture(options: { deleteFails?: boolean; updateFails?: boolean; noContext?: boolean } = {}) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const remove = vi.fn(async (_key: string) => {
    await gate;
    if (options.deleteFails) throw new Error("R2 unavailable");
  });
  const run = vi.fn(async () => {
    if (options.updateFails) throw new Error("D1 unavailable");
  });
  const bind = vi.fn((_at: string, _id: string) => ({ run }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const tasks: Promise<unknown>[] = [];
  const context = {
    env: { ASSETS: { delete: remove }, DB: { prepare } },
    get executionCtx() {
      if (options.noContext) throw new Error("No execution context");
      return { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } };
    },
  } as unknown as TestContext;
  return { context, tasks, release, remove, prepare, bind, run };
}

describe("Native File post-publication cleanup", () => {
  it("returns before cleanup and marks only the completed session after staging deletion", async () => {
    const f = cleanupFixture();
    expect(scheduleCompletedNativeUploadCleanup(f.context, row)).toBeUndefined();
    expect(f.tasks).toHaveLength(1);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(row.object_key);
    expect(f.run).not.toHaveBeenCalled();
    f.release();
    await Promise.all(f.tasks);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith("UPDATE file_upload_sessions SET cleaned_at=? WHERE id=? AND status='completed'");
    expect(f.bind).toHaveBeenCalledWith(expect.any(String), row.id);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("leaves the session for scheduled cleanup when staging deletion fails", async () => {
    const f = cleanupFixture({ deleteFails: true });
    scheduleCompletedNativeUploadCleanup(f.context, row);
    f.release();
    await expect(Promise.all(f.tasks)).resolves.toEqual([undefined]);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("leaves the session for scheduled cleanup when the marker write fails", async () => {
    const f = cleanupFixture({ updateFails: true });
    scheduleCompletedNativeUploadCleanup(f.context, row);
    f.release();
    await expect(Promise.all(f.tasks)).resolves.toEqual([undefined]);
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(row.object_key);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("does not start untracked cleanup without an execution context", () => {
    const f = cleanupFixture({ noContext: true });
    expect(scheduleCompletedNativeUploadCleanup(f.context, row)).toBeUndefined();
    expect(f.tasks).toHaveLength(0);
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });
});

describe("Native File finalize route with D1 and R2", () => {
  it("publishes exactly once, retains promoted bytes, and rejects failed promotion", async () => {
    const { DB: db, ASSETS: bucket } = env as unknown as { DB: D1Database; ASSETS: R2Bucket };
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const space = "spc_" + suffix;
    const model = "file_finalize_" + suffix.slice(0, 12);
    const principal: Principal = {
      type: "user", id: "usr_" + suffix, clientId: "app_" + suffix,
      scopes: ["resources:read", "resources:write"], tokenId: "tok_" + suffix,
    };
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(space, "Synthetic File", principal.id, now, now, "UTC"),
      db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)")
        .bind("mem_" + suffix, space, principal.id, "owner", now, now),
    ]);
    await publishModelDefinition({ DB: db } as Bindings, {
      type: "service", id: "svc_" + suffix, clientId: "lifespace-platform-admin",
      scopes: ["models:manage"], tokenId: "tok_admin_" + suffix,
    }, {
      definitionVersion: 1, key: model,
      display: { singular: "Synthetic File holder", plural: "Synthetic File holders" },
      fields: { attachment: { type: "file", nullable: true } },
      access: ["read", "write"],
    }, "initial");
    await db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(principal.clientId, model, "write", "service", "svc_" + suffix).run();

    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    // Inject a verified test Principal; the real route still evaluates current model/Space authority.
    app.use("*", async (c, next) => { c.set("principal", principal); await next(); });
    app.onError((error, c) => c.json({ error: { code: error instanceof ApiError ? error.code : "INTERNAL_ERROR" } },
      error instanceof ApiError ? error.status : 500));
    registerFileRoutes(app);
    const bytes = new TextEncoder().encode("synthetic finalize payload");

    async function fixture(fail?: "put" | "head") {
      const id = "upl_" + crypto.randomUUID().replaceAll("-", "");
      const file = "fil_" + crypto.randomUUID().replaceAll("-", "");
      const stage = `uploads/native/${space}/${id}`;
      const permanent = `files/${space}/${file}`;
      await db.prepare(`INSERT INTO file_upload_sessions(
        id,space_id,model_key,field_key,record_id,destination,file_id,object_key,name,content_type,
        expected_size,status,application_id,principal_type,principal_id,actor_type,actor_id,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        id, space, model, "attachment", null, "native", file, stage, "synthetic.txt", "text/plain",
        bytes.length, "pending", principal.clientId, principal.type, principal.id, principal.type, principal.id,
        new Date(Date.now() + 60_000).toISOString(), now,
      ).run();
      await bucket.put(stage, bytes, { httpMetadata: { contentType: "text/plain" } });
      const get = vi.fn((key: string) => bucket.get(key));
      const head = vi.fn((key: string) => fail === "head" && key === permanent ? Promise.resolve(null) : bucket.head(key));
      const put = vi.fn(async (key: string, value: ReadableStream | Uint8Array, options: R2PutOptions) => {
        if (fail === "put" && key === permanent) throw new Error("synthetic promotion failure");
        return bucket.put(key, value, options);
      });
      const remove = vi.fn((key: string) => bucket.delete(key));
      const bindings = { DB: db, ASSETS: { get, head, put, delete: remove }, ENVIRONMENT: "test" } as unknown as Bindings;
      const complete = async () => {
        const ctx = createExecutionContext();
        const response = await app.request(`http://localhost/api/v1/spaces/${space}/file-uploads/${id}/complete`,
          { method: "POST" }, bindings, ctx);
        await waitOnExecutionContext(ctx);
        return response;
      };
      const session = () => db.prepare("SELECT status,cleaned_at FROM file_upload_sessions WHERE id=?")
        .bind(id).first<{ status: string; cleaned_at: string | null }>();
      const published = () => db.prepare("SELECT status FROM files WHERE id=?")
        .bind(file).first<{ status: string }>();
      return { id, file, stage, permanent, get, head, put, remove, complete, session, published };
    }

    const successful = await fixture();
    const response = await successful.complete();
    expect(response.status).toBe(200);
    expect((await response.json<{ data: { id: string } }>()).data.id).toBe(successful.file);
    expect(successful.get).toHaveBeenCalledExactlyOnceWith(successful.stage);
    expect(successful.head).toHaveBeenCalledExactlyOnceWith(successful.permanent);
    expect(successful.put).toHaveBeenCalledTimes(1);
    expect(successful.remove).toHaveBeenCalledExactlyOnceWith(successful.stage);
    expect(await successful.published()).toEqual({ status: "ready" });
    expect(await successful.session()).toMatchObject({ status: "completed", cleaned_at: expect.any(String) });
    expect(await bucket.head(successful.stage)).toBeNull();
    expect(await (await bucket.get(successful.permanent))?.text()).toBe(new TextDecoder().decode(bytes));
    expect((await successful.complete()).status).toBe(409);
    expect(successful.put).toHaveBeenCalledTimes(1);
    expect(await successful.published()).toEqual({ status: "ready" });

    for (const failure of ["put", "head"] as const) {
      const failed = await fixture(failure);
      expect((await failed.complete()).status).toBe(failure === "put" ? 500 : 502);
      expect(await failed.published()).toBeNull();
      expect(await failed.session()).toMatchObject({ status: "failed", cleaned_at: null });
      expect(await bucket.head(failed.permanent)).toBeNull();
      expect(failed.remove).toHaveBeenCalledExactlyOnceWith(failed.permanent);
      expect(await bucket.head(failed.stage)).not.toBeNull();
    }
  }, 20000);
});

import type { Context } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Bindings, Variables } from "../src/env";
import { scheduleCompletedNativeUploadCleanup, verifyStagedUpload, type UploadSessionRow } from "../src/file-routes";

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

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource, getGenericResource, listGenericResources, updateGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";

const actor: Principal = {
  type: "user",
  id: "usr_record_icon_test",
  clientId: "app_test_runtime",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_record_icon_test",
};
function bindings(): Bindings {
  return { DB: (env as unknown as { DB: D1Database }).DB } as Bindings;
}

describe("native Record Icon projection and DayRecord cutover", () => {
  it("uses the shared icon across GET/LIST and preserves it across normal updates", async () => {
    const db = bindings().DB;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(spaceId, "Record Icon", actor.id, new Date().toISOString(), new Date().toISOString(), "UTC").run();
    const model = await getPublishedModel(bindings(), "day_record");
    expect(model).not.toBeNull();
    if (!model) return;
    expect(model.definition.fields).not.toHaveProperty("icon");

    const without = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "No icon", kind: "elapsed", anchorDate: "2026-10-01", status: "active",
    }, true);
    expect(without.presentation).toBeUndefined();
    expect((await getGenericResource(bindings(), spaceId, model, without.id))?.presentation).toBeUndefined();

    const icon = { type: "emoji", value: "📚" };
    const created = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Reading", kind: "elapsed", anchorDate: "2026-10-01", status: "active",
      presentation: { icon },
    }, true);
    expect(created.version).toBe(1);
    expect(created.presentation?.icon).toEqual(icon);
    const loaded = await getGenericResource(bindings(), spaceId, model, created.id);
    expect(loaded?.presentation?.icon).toEqual(icon);
    const listed = await listGenericResources(bindings(), spaceId, model);
    expect(listed.find(x => x.id === created.id)?.presentation?.icon).toEqual(icon);

    const updated = await updateGenericResource(bindings(), actor, spaceId, model, created.id, loaded!.version, {
      description: "Daily habit",
      presentation: { icon: { type: "emoji", value: "📖" } },
    });
    expect(updated.version).toBe(2);
    expect(updated.presentation?.icon).toEqual({ type: "emoji", value: "📖" });
    const preserved = await updateGenericResource(bindings(), actor, spaceId, model, created.id, updated.version, {
      name: "Read daily",
    });
    expect(preserved.version).toBe(3);
    expect(preserved.presentation?.icon).toEqual({ type: "emoji", value: "📖" });
    const cleared = await updateGenericResource(bindings(), actor, spaceId, model, created.id, preserved.version, {
      presentation: { icon: null },
    });
    expect(cleared.version).toBe(4);
    expect(cleared.presentation).toBeUndefined();
    const after = await getGenericResource(bindings(), spaceId, model, created.id);
    expect(after?.presentation).toBeUndefined();
    expect(after?.data).not.toHaveProperty("icon");
    await expect(createGenericResource(bindings(), actor, spaceId, model, {
      name: "Invalid", kind: "elapsed", anchorDate: "2026-10-01", status: "active",
      presentation: { icon: { type: "url", value: "https://unsafe.test" } },
    }, true)).rejects.toMatchObject({ code: "INVALID_RECORD_ICON" });
  });
  it("atomically binds a pre-uploaded image when creating a Record", async () => {
    const db = bindings().DB;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    const fileId = `fil_${crypto.randomUUID().replaceAll("-", "")}`;
    const sessionId = `upl_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
        .bind(spaceId, "Record Icon Image", actor.id, now, now, "UTC"),
      db.prepare(`INSERT INTO files(
        id,space_id,name,content_type,size_bytes,object_key,status,application_id,
        principal_type,principal_id,actor_type,actor_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(fileId, spaceId, "logo.png", "image/png", 128, `files/${spaceId}/${fileId}`,
          "ready", actor.clientId, actor.type, actor.id, actor.type, actor.id, now),
      db.prepare(`INSERT INTO file_upload_sessions(
        id,space_id,model_key,field_key,record_id,destination,file_id,object_key,name,content_type,
        expected_size,status,application_id,principal_type,principal_id,actor_type,actor_id,expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(sessionId, spaceId, "day_record", "__record_icon", null,
          "native", fileId, `uploads/native/${spaceId}/${sessionId}`, "logo.png", "image/png",
          128, "completed", actor.clientId, actor.type, actor.id, actor.type, actor.id,
          new Date(Date.now() + 60000).toISOString(), now),
    ]);
    const model = await getPublishedModel(bindings(), "day_record");
    expect(model).not.toBeNull();
    if (!model) return;
    const record = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Football Club", kind: "elapsed", anchorDate: "2026-10-01", status: "active",
      presentation: { icon: { type: "image", fileId } },
    }, true);
    expect(record.version).toBe(1);
    expect(record.presentation?.icon).toEqual({ type: "image", fileId });
    const link = await db.prepare("SELECT file_id FROM resource_file_links WHERE source_record_id=? AND field_key=?")
      .bind(record.id, "__record_icon").first<{ file_id: string }>();
    expect(link?.file_id).toBe(fileId);
    const loaded = await getGenericResource(bindings(), spaceId, model, record.id);
    expect(loaded?.presentation?.icon).toEqual({ type: "image", fileId });

    // A business-only update retains both the Icon metadata and its File link.
    // The previous SQL deleted all File links even when presentation.icon was omitted.
    const renamed = await updateGenericResource(bindings(), actor, spaceId, model, record.id, record.version, {
      name: "Football Club Renamed",
    });
    expect(renamed.version).toBe(2);
    expect(renamed.presentation?.icon).toEqual({ type: "image", fileId });
    const preservedLink = await db.prepare("SELECT file_id FROM resource_file_links WHERE source_record_id=? AND field_key=?")
      .bind(record.id, "__record_icon").first<{ file_id: string }>();
    expect(preservedLink?.file_id).toBe(fileId);
    expect((await getGenericResource(bindings(), spaceId, model, record.id))?.presentation?.icon)
      .toEqual({ type: "image", fileId });

    // An explicit replacement must still detach the old image File.
    const updated = await updateGenericResource(bindings(), actor, spaceId, model, record.id, renamed.version, {
      presentation: { icon: { type: "emoji", value: "⚽" } },
    });
    expect(updated.version).toBe(3);
    expect(updated.presentation?.icon).toEqual({ type: "emoji", value: "⚽" });
    const detached = await db.prepare("SELECT file_id FROM resource_file_links WHERE source_record_id=? AND field_key=?")
      .bind(record.id, "__record_icon").first<{ file_id: string }>();
    expect(detached).toBeNull();
  });

});

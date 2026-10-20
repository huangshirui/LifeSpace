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
});

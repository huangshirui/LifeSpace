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

    const created = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Reading", kind: "elapsed", anchorDate: "2026-10-01",
    });
    expect((await getGenericResource(bindings(), spaceId, model, created.id))?.presentation?.icon).toBeNull();
    const icon = { type: "emoji", value: "📚" };
    await db.prepare("UPDATE resource_records SET icon_json=? WHERE id=? AND space_id=?")
      .bind(JSON.stringify(icon), created.id, spaceId).run();

    const loaded = await getGenericResource(bindings(), spaceId, model, created.id);
    expect(loaded?.presentation?.icon).toEqual(icon);
    const listed = await listGenericResources(bindings(), spaceId, model);
    expect(listed.find(x => x.id === created.id)?.presentation?.icon).toEqual(icon);

    const updated = await updateGenericResource(bindings(), actor, spaceId, model, created.id, loaded!.version, {
      description: "Daily habit",
    });
    expect(updated.presentation?.icon).toEqual(icon);
    const after = await getGenericResource(bindings(), spaceId, model, created.id);
    expect(after?.presentation?.icon).toEqual(icon);
    expect(after?.data).not.toHaveProperty("icon");
  });
});

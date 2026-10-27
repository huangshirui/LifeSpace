import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { queryCanonicalResources } from "../src/canonical-query";
import { createGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";
import type { Bindings, Principal } from "../src/env";

const bindings = () => ({ DB: (env as unknown as { DB: D1Database }).DB }) as Bindings;
const actor: Principal = {
  type: "user", id: "usr_event_location_migration_test",
  clientId: "app_test_runtime", scopes: ["resources:read", "resources:write"],
  tokenId: "tok_event_location_migration",
};

async function fixture() {
  const db = bindings().DB;
  const token = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${token}`, now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Location Migration", actor.id, now, now, "Asia/Shanghai"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${token}`, spaceId, actor.id, "User", now, now),
  ]);
  const model = await getPublishedModel(bindings(), "event");
  if (!model) throw new Error("Published Event is missing after migration");
  return { model, spaceId };
}

describe("Event schema 74 Location coordinated cutover", () => {
  it("uses the exact published model and four canonical columns, without legacy scalar Location", async () => {
    const db = bindings().DB;
    const current = await db.prepare("SELECT schema_hash FROM model_definitions WHERE model_key='event' AND state='published'").first<{schema_hash:string}>();
    expect(current?.schema_hash).toBe("dbf441f1f8203ebec0e16b2d6569b7606764b924540efd7bad30fb1258a7b270");
    const previousLabel = await db.prepare("SELECT state FROM model_definitions WHERE model_key='event' AND schema_hash=?")
      .bind("7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6")
      .first<{ state: string }>();
    expect(previousLabel?.state).toBe("superseded");
    const fields = await db.prepare("PRAGMA table_info(mdl_event)").all<{name:string}>();
    const columns = new Set(fields.results.map((x) => x.name));
    expect(columns.has("location")).toBe(false);
    for (const field of ["__loc_location_name", "__loc_location_address", "__loc_location_latitude", "__loc_location_longitude"]) {
      expect(columns.has(field)).toBe(true);
    }
    const previous = await db.prepare("SELECT state FROM model_definitions WHERE model_key='event' AND schema_hash=?")
      .bind("be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a")
      .first<{state:string}>();
    expect(previous?.state).toBe("superseded");
  });

  it("preserves location name search and searches nearby coordinate-bearing Events", async () => {
    const { model, spaceId } = await fixture();
    const when = { kind: "date", start: "2026-10-31", endExclusive: "2026-11-01" };
    const nameOnly = await createGenericResource(bindings(), actor, spaceId, model, {
      summary: "School training", when, location: { name: "文来中学足球场" },
    });
    const coordinates = await createGenericResource(bindings(), actor, spaceId, model, {
      summary: "Match", when, location: {
        name: "运动场", address: "上海",
        coordinates: { latitude: 31, longitude: 121 },
      },
    });
    const nameMatch = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "文来中学" },
    });
    expect(nameMatch.items.map((v) => v.id)).toEqual([nameOnly.id]);
    const nearby = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { field: "location", op: "withinDistance",
        value: { point: { latitude: 31, longitude: 121 }, meters: 200 } },
    });
    expect(nearby.items.map((v) => v.id)).toEqual([coordinates.id]);
  });
});

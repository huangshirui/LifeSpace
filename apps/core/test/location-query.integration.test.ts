import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createGenericResource } from "../src/generic-resource";
import { queryCanonicalResources } from "../src/canonical-query";
import { publishModelDefinition } from "../src/model-registry";
import type { ModelDefinition } from "../src/model-definition";
import type { Bindings, Principal } from "../src/env";

const bindings = () => ({ DB: (env as unknown as { DB: D1Database }).DB }) as Bindings;
const actor: Principal = {
  type: "user",
  id: "usr_location_test",
  clientId: "app_test_runtime",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_location_test",
};
const publisher: Principal = {
  type: "service",
  id: "svc_location_test",
  clientId: "lifespace-platform-admin",
  scopes: ["models:manage"],
  tokenId: "tok_location_publisher",
};

async function fixture() {
  const db = bindings().DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Location", actor.id, now, now, "Asia/Shanghai"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, spaceId, actor.id, "Tester", now, now),
  ]);
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: `location_query_${suffix.slice(0, 16)}`,
    display: { singular: "Place Query", plural: "Place Queries" },
    fields: {
      name: { type: "string", required: true },
      place: { type: "location", nullable: true },
    },
    query: { searchable: ["name", "place"], filterable: ["place"], sortable: ["name"] },
    access: ["read", "write"],
  };
  const model = await publishModelDefinition(bindings(), publisher, definition, "initial");
  const insert = (name: string, place: unknown) =>
    createGenericResource(bindings(), actor, spaceId, model, { name, place });
  const nearA = await insert("Near A", { name: "文来中学", coordinates: { latitude: 31, longitude: 121 } });
  const nearB = await insert("Near B", { name: "球场", address: "上海", coordinates: { latitude: 31.00001, longitude: 121.00001 } });
  const far = await insert("Far", { name: "大阪", coordinates: { latitude: 34.69, longitude: 135.5 } });
  const unknown = await insert("Name Only", { name: "某地点" });
  const empty = await insert("Empty", null);
  return { spaceId, model, nearA, nearB, far, unknown, empty };
}

describe("Location Canonical Query / D1", () => {
  it("composes distance, boolean filtering, search, sort and stable cursors", async () => {
    const { spaceId, model, nearA, nearB, unknown, empty } = await fixture();
    const filter = { field: "place", op: "withinDistance", value: {
      point: { latitude: 31, longitude: 121 }, meters: 300,
    } };
    const placeSearch = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "文来中学" },
    });
    expect(placeSearch.items.map((item) => item.id)).toEqual([nearA.id]);
    const first = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "Near" }, filter, sort: [{ field: "name", direction: "asc" }], page: { limit: 1 },
    });
    expect(first.items.map((item) => item.id)).toEqual([nearA.id]);
    const second = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "Near" }, filter, sort: [{ field: "name", direction: "asc" }],
      page: { limit: 1, cursor: first.nextCursor },
    });
    expect(second.items.map((item) => item.id)).toEqual([nearB.id]);
    expect(second.nextCursor).toBeNull();
    const nested = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { or: [filter, { field: "place", op: "isNull" }] },
    });
    expect(new Set(nested.items.map((i) => i.id))).toEqual(new Set([nearA.id, nearB.id, empty.id]));
    const absent = await queryCanonicalResources(bindings(), actor, spaceId, model, { filter: {
      field: "place", op: "isNotNull",
    } });
    expect(absent.items.some((item) => item.id === unknown.id)).toBe(true);
    expect(await queryCanonicalResources(bindings(), actor, spaceId, model, { filter: {
      field: "place", op: "withinDistance",
      value: { point: { latitude: 31, longitude: 121 }, meters: 0.1 },
    } })).toMatchObject({ items: [expect.objectContaining({ id: nearA.id })] });
    await expect(queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { field: "place", op: "withinDistance", value: {
        point: { latitude: 91, longitude: 121 }, meters: 100,
      } },
    })).rejects.toThrow("WGS84");
  });

  it("handles WGS84 antimeridian wrap correctly", async () => {
    const { spaceId, model } = await fixture();
    const wrap = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "International date line",
      place: { name: "岛屿", coordinates: { latitude: 0, longitude: -179.999 } },
    });
    const result = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { field: "place", op: "withinDistance",
        value: { point: { latitude: 0, longitude: 179.999 }, meters: 1000 } },
    });
    expect(result.items.map((row) => row.id)).toContain(wrap.id);
  });
});

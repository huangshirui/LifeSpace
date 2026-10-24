import { describe, expect, it } from "vitest";
import { parseLocationValue } from "../src/location-value";
import { FIELD_TYPES, validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { validateResourceData } from "../src/generic-resource";
import { compilePhysicalSchema } from "../src/physical-schema";
import { dehydrateTypedResourceData, hydrateTypedResourceData } from "../src/typed-resource-storage";
import type { PublishedModel } from "../src/model-registry";
import { canonicalQuerySemanticDescriptor } from "../src/canonical-query-contract";
import { generateModelContract } from "../src/model-contract";

function definition(): ModelDefinition {
  return {
    definitionVersion: 1,
    key: "location_oracle",
    display: { singular: "Location Oracle", plural: "Location Oracles" },
    fields: {
      name: { type: "string", required: true },
      place: { type: "location", nullable: true },
    },
    query: { filterable: ["place"] },
    access: ["read", "write"],
  };
}

function model(): PublishedModel {
  return {
    id: "mdl_location_oracle",
    key: "location_oracle",
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition: definition(),
    publishedAt: "2026-10-24T00:00:00.000Z",
  };
}

describe("First-class Location semantics", () => {
  it("recognizes one bounded provider-neutral Location type", () => {
    expect(FIELD_TYPES).toContain("location");
    const validated = validateModelDefinition(definition());
    expect(validated.valid).toBe(true);
    expect(parseLocationValue({ name: "  学校  " })).toEqual({ name: "学校" });
    expect(parseLocationValue({
      name: " 球场 ", address: " 上海 ", coordinates: { latitude: 31.0, longitude: 121.0 },
    })).toEqual({
      name: "球场", address: "上海", coordinates: { latitude: 31, longitude: 121 },
    });
    for (const invalid of [
      "球场", {}, { name: "" }, { name: " " }, { name: "X".repeat(501) },
      { name: "球场", providerPlaceId: "google-123" },
      { name: "球场", coordinates: { latitude: 31 } },
      { name: "球场", coordinates: { latitude: 91, longitude: 121 } },
      { name: "球场", coordinates: { latitude: NaN, longitude: 121 } },
      { name: "球场", coordinates: { latitude: 31, longitude: -181 } },
      { name: "球场", address: "" },
    ]) {
      expect(parseLocationValue(invalid)).toBeNull();
    }
  });

  it("rejects defaults, text search, scalar ordering and unrelated field constraints", () => {
    const d = definition();
    for (const property of ["minLength", "maxLength", "minimum", "maximum", "values", "targetModel"]) {
      const field = { type: "location", [property]: property === "values" ? ["a"] : property === "targetModel" ? "event" : 2 };
      const result = validateModelDefinition({ ...d, fields: { ...d.fields, place: field } });
      expect(result.valid).toBe(false);
    }
    for (const query of [{ searchable: ["place"] }, { sortable: ["place"] }]) {
      expect(validateModelDefinition({ ...d, query }).valid).toBe(false);
    }
    expect(validateModelDefinition({ ...d, defaults: { place: null } }).valid).toBe(false);
  });

  it("stores typed columns and recreates the original logical object, with null and name-only values", () => {
    const published = model();
    const plan = compilePhysicalSchema(published.definition);
    expect(plan.fieldMappings.find((m) => m.fieldKey === "place")?.storage).toBe("location");
    expect(plan.columns.filter((c) => c.logicalFieldKey === "place").map((c) => [c.component, c.sqlType]))
      .toEqual([["name", "TEXT"], ["address", "TEXT"], ["latitude", "REAL"], ["longitude", "REAL"]]);
    expect(plan.createIndexSql.join(" ")).toContain('space_id,"__loc_place_latitude","__loc_place_longitude",record_id');
    expect(plan.createTableSql).toContain("BETWEEN -90 AND 90");
    expect(plan.createTableSql).toContain("BETWEEN -180 AND 180");
    const nameOnly = validateResourceData(published.definition, { name: "A", place: { name: "学校" } }, "create");
    expect(hydrateTypedResourceData(published, dehydrateTypedResourceData(published, nameOnly))).toEqual(nameOnly);
    const withCoords = validateResourceData(published.definition, {
      name: "B", place: { name: "学校", address: "长宁区", coordinates: { latitude: 31, longitude: 121 } },
    }, "create");
    expect(hydrateTypedResourceData(published, dehydrateTypedResourceData(published, withCoords))).toEqual(withCoords);
    const empty = validateResourceData(published.definition, { name: "C", place: null }, "create");
    expect(hydrateTypedResourceData(published, dehydrateTypedResourceData(published, empty))).toEqual(empty);
    const corrupt = { ...dehydrateTypedResourceData(published, withCoords), __loc_place_longitude: null };
    expect(() => hydrateTypedResourceData(published, corrupt)).toThrow("Location place is invalid");
    expect(() => validateResourceData(published.definition, { name: "D", place: "上海" }, "create")).toThrow("valid Location object");
  });

  it("publishes canonical schema and typed distance predicate discovery", async () => {
    const p = model();
    const descriptor = canonicalQuerySemanticDescriptor(p);
    expect(descriptor.filter.targets.find((target) => target.field === "place")?.operators)
      .toEqual(["withinDistance", "isNull", "isNotNull"]);
    const contract = await generateModelContract([p]);
    const schemas = (contract.openapi.components as Record<string, any>).schemas;
    const create = Object.values(schemas).find((schema: any) =>
      JSON.stringify(schema).includes('"x-lifespace-type":"location"')
    ) as any;
    expect(create).toBeTruthy();
    expect(JSON.stringify(create)).toContain('"x-lifespace-crs":"WGS84"');
    expect(JSON.stringify(contract.openapi)).toContain("withinDistance");
  });
});

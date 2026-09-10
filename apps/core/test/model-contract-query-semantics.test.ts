import { describe, expect, it } from "vitest";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";

function published(): PublishedModel {
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: "contract_time_query",
    display: { singular: "Contract Time Query", plural: "Contract Time Queries" },
    fields: {
      name: { type: "string", required: true },
      dueDate: { type: "date", nullable: true },
      observedAt: { type: "datetime", nullable: true },
    },
    query: { filterable: ["dueDate", "observedAt"] },
    access: ["read"],
  };
  return {
    id: "mdl_contract_time_query",
    key: definition.key,
    version: 1,
    state: "published",
    schemaHash: "a".repeat(64),
    compatibility: "initial",
    definition,
    publishedAt: "2026-09-10T00:00:00.000Z",
  };
}

function parameters(document: Record<string, any>): Array<Record<string, any>> {
  return document.paths["/api/v1/spaces/{spaceId}/models/contract_time_query/records"].get.parameters;
}

describe("generated Model Contract comparison query semantics", () => {
  it("publishes explicit operator and local-date-window metadata without hiding legacy aliases", async () => {
    const contract = await generateModelContract([published()]);
    const params = parameters(contract.openapi);
    const byName = (name: string) => params.find((parameter) => parameter.name === name);

    expect(byName("dueDateFrom")).toMatchObject({
      "x-lifespace-query-field": "dueDate",
      "x-lifespace-query-source": "model",
      "x-lifespace-operator": "gte",
      "x-lifespace-transport": "legacy",
    });
    expect(byName("dueDate.lt")).toMatchObject({
      "x-lifespace-query-field": "dueDate",
      "x-lifespace-query-source": "model",
      "x-lifespace-operator": "lt",
      "x-lifespace-transport": "explicit",
    });
    expect(byName("createdAt.gte")).toMatchObject({
      "x-lifespace-query-field": "createdAt",
      "x-lifespace-query-source": "envelope",
      "x-lifespace-operator": "gte",
      "x-lifespace-transport": "explicit",
    });
    expect(byName("observedAt.dateStart")).toMatchObject({
      "x-lifespace-query-field": "observedAt",
      "x-lifespace-query-source": "model",
      "x-lifespace-local-date-window-role": "date-start",
      "x-lifespace-window-bounds": "[)",
    });
    expect(byName("observedAt.dateEndExclusive")?.schema?.format).toBe("date");
    expect(byName("observedAt.timezone")?.schema?.["x-lifespace-format"]).toBe("iana-timezone");
  });
});

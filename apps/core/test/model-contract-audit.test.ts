import { describe, expect, it } from "vitest";
import { TASK_MODEL_DEFINITION } from "../src/builtin-models";
import { generateModelContract } from "../src/model-contract";
import type { PublishedModel } from "../src/model-registry";

function task(): PublishedModel {
  return {
    id: "mdl_task",
    key: "task",
    route: TASK_MODEL_DEFINITION.route,
    version: 2,
    state: "published",
    schemaHash: "1".repeat(64),
    compatibility: "initial",
    definition: TASK_MODEL_DEFINITION,
    publishedAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("Generic Resource audit contract", () => {
  it("publishes createdBy and updatedBy on every model resource", async () => {
    const snapshot = await generateModelContract([task()]);
    const schemas = (snapshot.openapi.components as {
      schemas: Record<string, Record<string, unknown>>;
    }).schemas;
    const resource = schemas.TaskResource as {
      properties: Record<string, {
        type?: string;
        readOnly?: boolean;
        properties?: Record<string, { enum?: string[]; type?: string }>;
        required?: string[];
      }>;
      required: string[];
    };

    for (const field of ["createdBy", "updatedBy"] as const) {
      const actor = resource.properties[field];
      expect(actor?.type).toBe("object");
      expect(actor?.readOnly).toBe(true);
      expect(actor?.properties?.type?.enum).toEqual(["user", "service", "device"]);
      expect(actor?.properties?.id?.type).toBe("string");
      expect(actor?.properties?.displayName?.type).toBe("string");
      expect(actor?.required).toEqual(["type", "id", "displayName"]);
      expect(resource.required).toContain(field);
    }
  });
});

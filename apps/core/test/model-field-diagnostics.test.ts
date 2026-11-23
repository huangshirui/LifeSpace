import { describe, expect, it } from "vitest";
import { validateResourceData } from "../src/generic-resource";
import { ApiError, failure, modelFieldValidationDetails } from "../src/http";
import type { ModelDefinition } from "../src/model-definition";

// A synthetic Model Definition; no current resource, user or provider details.
const model = {
  key: "synthetic_diagnostic",
  fields: {
    name: { type: "string", required: true, nullable: false, minLength: 1 },
    category: { type: "enum", values: ["general", "report"], nullable: false },
    note: { type: "string", nullable: true, maxLength: 12 },
    fixed: { type: "string", immutable: true, nullable: true },
    internal: { type: "string", readOnly: true, nullable: true },
  },
} as unknown as ModelDefinition;

function problem(input: Record<string, unknown>, operation: "create" | "update" = "create",
  previous?: Record<string, unknown>) {
  try {
    validateResourceData(model, input, operation, previous);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw Error("Expected a synthetic model field validation failure");
}

describe("canonical Native field validation diagnostics", () => {
  it("locates a missing required field without exposing a whole model schema", () => {
    const err = problem({});
    expect(err.code).toBe("INVALID_RESOURCE");
    expect(err.status).toBe(400);
    expect(err.details).toEqual({
      fieldPath: "data.name", reasonCode: "FIELD_REQUIRED",
      repair: "Supply this required field using the current authorized Model Contract.",
    });
  });
  it("reports caller-owned enum/value/unknown/read-only paths", () => {
    expect(problem({name:"ok",category:"not-an-enum"}).details).toMatchObject({
      fieldPath:"data.category",reasonCode:"FIELD_INVALID_ENUM",
    });
    expect(problem({name:"ok",note:"a".repeat(20)}).details).toMatchObject({
      fieldPath:"data.note",reasonCode:"FIELD_INVALID_VALUE",
    });
    expect(problem({name:"ok",undocumented:1}).details).toMatchObject({
      fieldPath:"data.undocumented",reasonCode:"FIELD_UNKNOWN",
    });
    expect(problem({name:"ok",internal:"forbidden"}).details).toMatchObject({
      fieldPath:"data.internal",reasonCode:"FIELD_READ_ONLY",
    });
    expect(problem({fixed:"changed"}, "update", {fixed:"original"}).details).toMatchObject({
      fieldPath:"data.fixed",reasonCode:"FIELD_IMMUTABLE",
    });
  });
  it("never includes caller values, unknown oversized keys, or record existence", () => {
    const secret="synthetic-untrusted-value";
    const err=problem({name:"ok",category:secret});
    expect(JSON.stringify(err.details)).not.toContain(secret);
    expect(modelFieldValidationDetails("x".repeat(100),"FIELD_UNKNOWN")).toBeUndefined();
    const safe=failure(err.code,err.message,"test-request-id",err.details);
    expect(safe.error.details?.fieldPath).toBe("data.category");
    expect(failure("FORBIDDEN","not authorized","test-request-id").error)
      .toEqual({code:"FORBIDDEN",message:"not authorized",requestId:"test-request-id"});
  });
});

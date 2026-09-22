import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStablePublicSchemaBaseline,
  compareOperationCompatibility,
  compareStablePublicBaselines,
  normalizeOperation,
} from "./stable-contract-compatibility.mjs";

function operation({ requestSchema, responseSchema, parameter } = {}) {
  return {
    parameters: parameter ? [parameter] : [],
    requestBody: requestSchema ? {
      required: false,
      content: { "application/json": { schema: requestSchema } },
    } : null,
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: responseSchema ?? {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } },
            },
          },
        },
        headers: {},
      },
    },
  };
}

test("allows additive optional request properties and additive response properties", () => {
  const before = operation({
    requestSchema: {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  });
  const after = operation({
    requestSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        note: { type: "string" },
      },
    },
    responseSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        displayName: { type: "string" },
      },
    },
  });
  assert.deepEqual(compareOperationCompatibility(before, after, "POST /items"), []);
});

test("rejects newly required input and request enum narrowing", () => {
  const before = operation({
    requestSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["owner", "member"] },
      },
    },
  });
  const after = operation({
    requestSchema: {
      type: "object",
      required: ["role"],
      properties: {
        role: { type: "string", enum: ["owner"] },
      },
    },
  });
  const errors = compareOperationCompatibility(before, after, "POST /items");
  assert(errors.some((error) => error.includes("newly required request property role")));
  assert(errors.some((error) => error.includes("request enum removed")));
});

test("rejects removed response fields, required-response weakening and widened response types", () => {
  const before = operation({
    responseSchema: {
      type: "object",
      required: ["id", "state"],
      properties: {
        id: { type: "string" },
        state: { type: "string" },
      },
    },
  });
  const after = operation({
    responseSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: ["string", "number"] },
      },
    },
  });
  const errors = compareOperationCompatibility(before, after, "GET /items/{id}");
  assert(errors.some((error) => error.includes("required response property state")));
  assert(errors.some((error) => error.includes("documented response property state was removed")));
  assert(errors.some((error) => error.includes("response type set changed incompatibly")));
});

test("rejects request parameter removal or becoming required", () => {
  const oldOptional = { name: "cursor", in: "query", required: false, schema: { type: "string" } };
  const removed = compareOperationCompatibility(
    operation({ parameter: oldOptional }),
    operation(),
    "GET /items",
  );
  assert(removed.some((error) => error.includes("query:cursor was removed or renamed")));

  const becameRequired = compareOperationCompatibility(
    operation({ parameter: oldOptional }),
    operation({ parameter: { ...oldOptional, required: true } }),
    "GET /items",
  );
  assert(becameRequired.some((error) => error.includes("became required")));
});

test("normalization dereferences local component schemas instead of freezing component names", () => {
  const document = {
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Item" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Item: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", description: "annotation ignored" } },
        },
      },
    },
  };
  const normalized = normalizeOperation(document, "GET", "/items");
  assert.deepEqual(
    normalized.responses["200"].content["application/json"].schema,
    {
      properties: { id: { type: "string" } },
      required: ["id"],
      type: "object",
    },
  );
});

test("builds evidence only for Stable Public groups and rejects Stable operation removal", () => {
  const classification = {
    contractSources: [{
      id: "example",
      source: "example.json",
      groups: [
        { id: "stable-public", maturity: "stable", visibility: "public", operationPattern: "^GET /items$" },
        { id: "candidate-public", maturity: "candidate", visibility: "public", operationPattern: "^POST /items$" },
      ],
    }],
  };
  const document = {
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
        post: { responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } } },
      },
    },
  };
  const accepted = buildStablePublicSchemaBaseline(classification, { "example.json": document });
  assert.deepEqual(Object.keys(accepted.operations), ["example::GET /items"]);
  const current = { ...accepted, operations: {} };
  const errors = compareStablePublicBaselines(accepted, current);
  assert(errors.some((error) => error.includes("Stable Public operation was removed or renamed")));
});

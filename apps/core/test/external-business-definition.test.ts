import { describe, it, expect } from "vitest";
import { validateModelDefinition } from "../src/model-definition";
const base = { definitionVersion: 1, origin: "external", key: "external_document", display: { singular: "Document", plural: "Documents" }, fields: {}, access: ["read", "write"] };
describe("External business semantics", () => {
 it("accepts stable business semantics with no Provider field template", () => { const result = validateModelDefinition(base); expect(result.valid).toBe(true); });
 it("rejects copied Provider fields and Native capabilities/actions/policy/concurrency", () => {
  for (const patch of [{ fields: { name: { type: "string" } } }, { capabilities: {} }, { actions: {} }, { policies: {} }, { lifecycle: {} }, { access: ["manage"] }, { defaults: {} }]) expect(validateModelDefinition({ ...base, ...patch }).valid).toBe(false);
 });
});

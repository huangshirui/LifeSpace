import { describe, expect, it } from "vitest";
import { validateModelDefinition, validateCanonicalFieldDefinition } from "../src/model-definition";
import { generateModelContract } from "../src/model-contract";
import { normalizeCanonicalFieldValue, validateResourceData } from "../src/generic-resource";
import type { PublishedModel } from "../src/model-registry";

const wire = "lsenc1.1.AAECAwQFBgcICQoL.AAAAAAAAAAAAAAAAAAAAAA";
const opts = { allowCandidateEncryption: true };
const input = (field: Record<string, unknown> = { type: "string", encrypted: true }) => ({
  definitionVersion: 1, key: "encrypted_probe", display: { singular: "Probe", plural: "Probes" },
  fields: { title: { type: "string" }, secret: field }, access: ["read", "write"],
});
function valid(raw: unknown) {
  const result = validateModelDefinition(raw, opts);
  if (!result.valid) throw new Error(JSON.stringify(result.issues));
  return result;
}

describe("encrypted model candidate (publication gated)", () => {
  it("accepts four Native types only when explicitly enabled internally", () => {
    for (const type of ["string", "text", "file", "file_list"]) {
      expect(valid(input({ type, encrypted: true })).definition.fields.secret.encrypted).toBe(true);
      expect(validateModelDefinition(input({ type, encrypted: true })).valid).toBe(false);
      expect(validateCanonicalFieldDefinition({ type, encrypted: true }).valid).toBe(false);
    }
    for (const type of ["number","boolean","date","file_ref_list"]) {
      expect(validateModelDefinition(input({ type, encrypted: true }), opts).valid).toBe(false);
    }
    expect(validateModelDefinition(input({ type: "text", encrypted: "yes" }), opts).valid).toBe(false);
    expect(validateModelDefinition(input({ type: "text", encrypted: true, readOnly: true }), opts).valid).toBe(false);
    expect(validateModelDefinition({ ...input(), origin: "external" }, opts).valid).toBe(false);
  });
  it("false is identical to absence and preserves canonical hashes", () => {
    const a = valid(input({ type: "string" }));
    const b = valid(input({ type: "string", encrypted: false }));
    expect(b.hashInput).toBe(a.hashInput);
    expect(b.definition.fields.secret).toEqual(a.definition.fields.secret);
  });
  it("rejects server-side dependencies without restricting normal fields", () => {
    for (const metadata of [
      { defaults: { secret: "plaintext" } },
      { query: { searchable: ["secret"] } },
      { query: { filterable: ["secret"] } },
      { query: { sortable: ["secret"] } },
      { referenceLabel: { field: "secret" } },
      { referenceLabel: { template: "{title} {secret}" } },
      { policies: { read: { op: "eq", left: { $ref: "record.secret" }, right: { value: "x" } } } },
      { actions: { change: { access: "write", set: { secret: "x" } } } },
      { actions: { change: { access: "write", guards: [{field:"secret",op:"eq",value:"x",errorCode:"SECRET_GUARD",message:"guard"}], set: { title: "x" } } } },
    ]) expect(validateModelDefinition({ ...input(), ...metadata }, opts).valid).toBe(false);
    expect(valid({ ...input(), query: { searchable: ["title"] }, referenceLabel: {field:"title"}, defaults:{title:"visible"} }).definition.fields.secret.encrypted).toBe(true);
  });
  it("generates a ciphertext schema without applying plaintext length constraints", async () => {
    const definition = valid(input({ type: "string", encrypted: true, minLength: 1, maxLength: 8 })).definition;
    const model: PublishedModel = { id:"mdl_probe", key:definition.key, version:1, state:"published", schemaHash:"a".repeat(64), compatibility:"initial", definition, publishedAt:"2026-01-01T00:00:00Z" };
    const contract = await generateModelContract([model]);
    const defs = contract.jsonSchema.$defs as Record<string, {properties: Record<string, Record<string, unknown>>}>;
    const field = defs.EncryptedProbeCreate.properties.secret;
    expect(field["x-lifespace-encryption"]).toEqual({mode:"client",logicalType:"string",wireFormat:"lsenc1",plaintextMinLength:1,plaintextMaxLength:8});
    expect(field.minLength).toBeUndefined();
    expect(Number(field.maxLength)).toBeGreaterThan(wire.length);
    expect(new RegExp(String(field.pattern)).test(wire)).toBe(true);
    expect(new RegExp(String(field.pattern)).test("plaintext")).toBe(false);
  });
  it("validates encrypted text without trimming; encrypted File input fails closed", () => {
    const definition = valid(input({ type: "string", encrypted: true, maxLength: 8, nullable: true })).definition;
    expect(validateResourceData(definition,{title:"visible",secret:wire},"create")).toEqual({title:"visible",secret:wire});
    expect(validateResourceData(definition,{title:"visible"},"create")).toEqual({title:"visible"});
    expect(validateResourceData(definition,{secret:null},"create")).toEqual({secret:null});
    for (const value of ["plaintext"," "+wire,wire+" ",wire+"="]) {
      expect(()=>validateResourceData(definition,{secret:value},"create")).toThrow("valid encrypted text envelope");
    }
    expect(()=>normalizeCanonicalFieldValue("attachment",{type:"file",encrypted:true},"fil_"+"a".repeat(32))).toThrow("not yet supported");
    expect(()=>normalizeCanonicalFieldValue("attachments",{type:"file_list",encrypted:true},[])).toThrow("not yet supported");
  });
});

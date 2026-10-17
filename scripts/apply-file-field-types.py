from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1):
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual < count:
        raise SystemExit(f"{path}: expected at least {count} occurrences, found {actual}: {old[:120]!r}")
    text = text.replace(old, new, count)
    p.write_text(text)


def replace_all(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"{path}: missing {old[:120]!r}")
    p.write_text(text.replace(old, new))

# Canonical field language.
replace(
    "apps/core/src/model-definition.ts",
    '  "enum_list",\n  "file_ref_list",\n  "person",',
    '  "enum_list",\n  "file",\n  "file_list",\n  "file_ref_list",\n  "person",',
)
replace(
    "apps/core/src/model-definition.ts",
    '  if (["recurrence_rule", "entity_ref", "file_ref_list"].includes(field.type) || field.type === "temporal_range" || isFirstClassRangeFieldType(field.type)) return false;',
    '  if (["recurrence_rule", "entity_ref", "file", "file_list", "file_ref_list"].includes(field.type) || field.type === "temporal_range" || isFirstClassRangeFieldType(field.type)) return false;',
)
replace_all(
    "apps/core/src/model-definition.ts",
    '["enum_list", "file_ref_list"]',
    '["enum_list", "file", "file_list", "file_ref_list"]',
)

# Native physical storage: stable file IDs are scalar/list values; bytes never enter typed tables.
replace(
    "apps/core/src/physical-schema.ts",
    'const JSON_ARRAY_TYPES = new Set(["enum_list", "file_ref_list"]);',
    'const JSON_ARRAY_TYPES = new Set(["enum_list", "file_list", "file_ref_list"]);',
)

# Canonical value validation. file/file_list contain stable fil_* identities only.
replace(
    "apps/core/src/generic-resource.ts",
    '    case "enum_list": return enumListValue(value, fieldKey, field);\n    case "file_ref_list": {',
    '''    case "enum_list": return enumListValue(value, fieldKey, field);\n    case "file": {\n      if (typeof value !== "string" || !/^fil_[a-f0-9]{32}$/u.test(value)) {\n        throw new ApiError("INVALID_RESOURCE", `${fieldKey} must contain a stable File ID`, 400);\n      }\n      return value;\n    }\n    case "file_list": {\n      if (!Array.isArray(value) || value.length > 100\n        || value.some((entry) => typeof entry !== "string" || !/^fil_[a-f0-9]{32}$/u.test(entry))\n        || new Set(value).size !== value.length) {\n        throw new ApiError("INVALID_RESOURCE", `${fieldKey} must contain at most 100 unique stable File IDs`, 400);\n      }\n      return [...value];\n    }\n    case "file_ref_list": {''',
)

replace(
    "apps/core/src/typed-resource-storage.ts",
    '  if (["recurrence_rule", "entity_ref", "enum_list", "file_ref_list"].includes(field.type)) return JSON.stringify(value);',
    '  if (["recurrence_rule", "entity_ref", "enum_list", "file_list", "file_ref_list"].includes(field.type)) return JSON.stringify(value);',
)

# Policy/workflow type projections remain conservative for list-valued fields.
replace(
    "apps/core/src/policy-definition.ts",
    '    case "person":\n    case "record": return { kind: "string", nullable: field.nullable };\n    case "enum_list":\n    case "file_ref_list":',
    '    case "person":\n    case "record":\n    case "file": return { kind: "string", nullable: field.nullable };\n    case "enum_list":\n    case "file_list":\n    case "file_ref_list":',
)
replace(
    "apps/core/src/workflow-definition.ts",
    '    case "enum_list":\n    case "file_ref_list":\n    case "person_list":',
    '    case "enum_list":\n    case "file_list":\n    case "file_ref_list":\n    case "person_list":',
)

# Native generic query does not infer File content/identity query semantics in V1.
replace(
    "apps/core/src/generic-query.ts",
    '    case "enum_list":\n    case "file_ref_list":',
    '    case "enum_list":\n    case "file":\n    case "file_list":\n    case "file_ref_list":',
)
replace_all(
    "apps/core/src/canonical-query.ts",
    '["person", "person_list", "record", "record_list", "enum_list", "file_ref_list"]',
    '["person", "person_list", "record", "record_list", "enum_list", "file", "file_list", "file_ref_list"]',
)
replace(
    "apps/core/src/canonical-query.ts",
    '    case "enum_list":\n    case "file_ref_list":\n      throw new ApiError("INVALID_QUERY", "Structured field is not a scalar comparison", 400);',
    '    case "enum_list":\n    case "file":\n    case "file_list":\n    case "file_ref_list":\n      throw new ApiError("INVALID_QUERY", "Structured field is not a scalar comparison", 400);',
)
replace_all(
    "apps/core/src/model-registry.ts",
    '["enum_list", "file_ref_list"]',
    '["enum_list", "file", "file_list", "file_ref_list"]',
)

# Generated Model Contract shapes.
replace(
    "apps/core/src/model-contract.ts",
    '    case "file_ref_list":\n      schema = fileRefListSchema();\n      break;\n    case "person":',
    '''    case "file":\n      schema = { type: "string", pattern: "^fil_[a-f0-9]{32}$" };\n      break;\n    case "file_list":\n      schema = {\n        type: "array",\n        maxItems: 100,\n        uniqueItems: true,\n        items: { type: "string", pattern: "^fil_[a-f0-9]{32}$" },\n      };\n      break;\n    case "file_ref_list":\n      schema = fileRefListSchema();\n      break;\n    case "person":''',
)

# Human-readable normative spec had drifted behind enum_list/file_ref_list; repair it while adding Native File IDs.
spec = Path("docs/model-definition-spec.md")
text = spec.read_text()
needle = '| `enum` | String | One value from `values` |\n| `person` | String ID | Person reference |'
replacement = '''| `enum` | String | One value from `values` |\n| `enum_list` | String array | Unique values constrained by `values`; see `model-definition-collection-types.md` |\n| `file` | `fil_*` string | Stable reference to one LifeSpace-owned File |\n| `file_list` | `fil_*` string array | Ordered unique references to LifeSpace-owned Files; max 100 |\n| `file_ref_list` | File reference array | Provider-owned `{name,url,expiresAt?}` references; see `model-definition-collection-types.md` |\n| `person` | String ID | Person reference |'''
if needle not in text:
    raise SystemExit("docs/model-definition-spec.md: canonical field table anchor not found")
spec.write_text(text.replace(needle, replacement, 1))

collection = Path("docs/model-definition-collection-types.md")
text = collection.read_text()
insert = '''\n## `file` / `file_list`\n\n`file` and `file_list` are Native LifeSpace File identity references. They store stable `fil_*` IDs only; file bytes and temporary access URLs never enter ordinary Model record storage.\n\nCanonical values:\n\n```json\n"fil_0123456789abcdef0123456789abcdef"\n```\n\n```json\n["fil_0123456789abcdef0123456789abcdef"]\n```\n\nRules:\n\n- `file` is one stable LifeSpace File ID; `file_list` is an ordered unique array of at most 100 File IDs;\n- referenced Files must be `ready` and belong to the same Space; Runtime validates this against the File resource store before record mutation;\n- File bytes are owned by LifeSpace and stored outside typed record tables (R2 in the Cloudflare deployment);\n- URLs are short-lived access projections and are never the field identity/value;\n- Model Definition v1 does not allow defaults or generic searchable/filterable/sortable declarations for these types;\n- upload/download are separate File capabilities and are not encoded as arbitrary binary/URL values in ordinary Record mutation.\n\n'''
marker = '## `file_ref_list`\n'
if marker not in text:
    raise SystemExit("collection types doc marker missing")
collection.write_text(text.replace(marker, insert + marker, 1))

# Contract-level regression tests.
Path("apps/core/test/native-file-field-contract.test.ts").write_text(r'''import { describe, expect, it } from "vitest";
import { normalizeCanonicalFieldValue } from "../src/generic-resource";
import { validateModelDefinition } from "../src/model-definition";
import { compilePhysicalSchema } from "../src/physical-schema";

const fileId = "fil_0123456789abcdef0123456789abcdef";

function definition(type: "file" | "file_list") {
  return {
    definitionVersion: 1 as const,
    key: `file_${type.replaceAll("_", "")}`,
    display: { singular: "File holder", plural: "File holders" },
    access: ["read", "write"] as const,
    fields: { attachment: { type } },
  };
}

describe("Native File canonical field contract", () => {
  it("accepts file and file_list as Canonical Field Types with stable IDs", () => {
    for (const type of ["file", "file_list"] as const) {
      const result = validateModelDefinition(definition(type));
      expect(result.valid).toBe(true);
    }
    expect(normalizeCanonicalFieldValue("attachment", { type: "file" }, fileId)).toBe(fileId);
    expect(normalizeCanonicalFieldValue("attachment", { type: "file_list" }, [fileId])).toEqual([fileId]);
  });

  it("rejects malformed and duplicate file identities", () => {
    expect(() => normalizeCanonicalFieldValue("attachment", { type: "file" }, "https://example.com/a.pdf")).toThrow();
    expect(() => normalizeCanonicalFieldValue("attachment", { type: "file_list" }, [fileId, fileId])).toThrow();
  });

  it("stores one file as scalar identity and file_list as JSON without scalar indexes", () => {
    const one = validateModelDefinition(definition("file"));
    const many = validateModelDefinition(definition("file_list"));
    if (!one.valid || !many.valid) throw new Error("fixture invalid");
    const onePlan = compilePhysicalSchema(one.definition);
    const manyPlan = compilePhysicalSchema(many.definition);
    expect(onePlan.columns.find((column) => column.logicalFieldKey === "attachment")?.sqlType).toBe("TEXT");
    expect(manyPlan.columns.find((column) => column.logicalFieldKey === "attachment")?.checkSql).toContain("json_type");
  });
});
''')

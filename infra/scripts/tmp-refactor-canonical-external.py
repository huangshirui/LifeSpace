from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


subprocess.check_call(["git", "fetch", "origin", "main", "--depth=1"], cwd=ROOT)

# Restore the hand-maintained OpenAPI formatting from main and apply only semantic changes.
external_contract = ROOT / "apps/core/external-model.openapi.yaml"
contract = run("git", "show", "origin/main:apps/core/external-model.openapi.yaml")
contract = replace_once(contract, '    "version": "0.3.0",', '    "version": "0.4.0",', "External contract version")
contract = replace_once(
    contract,
    '          "type": { "enum": ["string", "text", "number", "boolean", "enum", "instant"] },',
    '          "type": { "type": "string", "description": "Canonical LifeSpace Field Type; External Models reuse the same Canonical Field Language as Native Models." },',
    "ExternalField.type",
)
contract = replace_once(
    contract,
    '          "values": { "type": "array", "items": { "type": "string" } }',
    '          "values": { "type": "array", "items": { "type": "string" } },\n          "valueSchema": { "type": "object", "additionalProperties": true, "description": "Core-projected canonical value schema for structured field types when applicable." }',
    "ExternalField.valueSchema",
)
contract = replace_once(
    contract,
    '        "additionalProperties": { "type": ["string", "number", "boolean", "null"] },',
    '        "additionalProperties": true,',
    "DynamicRecord.additionalProperties",
)
contract = replace_once(
    contract,
    '      "ExternalWriteData": { "type": "object", "additionalProperties": { "type": ["string", "number", "boolean", "null"] } },',
    '      "ExternalWriteData": { "type": "object", "additionalProperties": true },',
    "ExternalWriteData.additionalProperties",
)
contract = replace_once(
    contract,
    '        "properties": { "field": { "type": "string" }, "op": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "isNull", "isNotNull"] }, "value": { "type": ["string", "number", "boolean"] } }',
    '        "properties": { "field": { "type": "string" }, "op": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "isNull", "isNotNull"] }, "value": {} }',
    "ExternalFilterPredicate.value",
)
external_contract.write_text(contract)

# External semantic detail must project the same structured valueSchema as Native discovery.
external_runtime = ROOT / "apps/core/src/external-runtime.ts"
text = external_runtime.read_text()
text = replace_once(
    text,
    'import { normalizeCanonicalFieldValue } from "./generic-resource";\n',
    'import { normalizeCanonicalFieldValue } from "./generic-resource";\nimport { recurrenceRuleSchema } from "./recurrence-rule";\nimport { entityRefSchema } from "./entity-ref";\n',
    "external-runtime imports",
)
text = replace_once(
    text,
    '  const readable = m.snapshot.fields.map(({ sourceFieldId: _id, ...f }) => ({\n    ...f,\n    writable:',
    '  const readable = m.snapshot.fields.map(({ sourceFieldId: _id, ...f }) => ({\n    ...f,\n    ...(f.type === "recurrence_rule"\n      ? { valueSchema: recurrenceRuleSchema() }\n      : f.type === "entity_ref"\n        ? { valueSchema: entityRefSchema() }\n        : {}),\n    writable:',
    "external structured valueSchema projection",
)
external_runtime.write_text(text)

# Remove temporary implementation machinery before the final branch commit.
for relative in [
    ".github/workflows/tmp-canonical-external-field-language.yml",
    "infra/scripts/tmp-refactor-canonical-external.py",
]:
    path = ROOT / relative
    if path.exists():
        path.unlink()

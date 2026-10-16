from pathlib import Path
import subprocess

path = Path("apps/core/external-model.openapi.yaml")
base = subprocess.run(
    ["git", "show", "origin/main:apps/core/external-model.openapi.yaml"],
    check=True,
    capture_output=True,
    text=True,
).stdout

replacements = [
    ('"version": "0.3.0"', '"version": "0.4.0"'),
    (
        '"description": "Provider-neutral External Model binding and dynamic Generic Runtime contract. Connection creation and provider credential ownership are defined by external-connection.openapi.yaml. Provider business data remains external. No transaction/version/distributed atomicity guarantee is introduced."',
        '"description": "Provider-neutral External Model binding and dynamic Generic Runtime contract. External fields use the same LifeSpace Canonical Field Language as Native models; provider adapters expose only the canonical types/capabilities they can map without loss. Connection creation and provider credential ownership are defined by external-connection.openapi.yaml. Provider business data remains external. No transaction/version/distributed atomicity guarantee is introduced."',
    ),
    (
        '"type": { "enum": ["string", "text", "number", "boolean", "enum", "instant"] },',
        '"type": { "enum": ["string", "text", "integer", "number", "boolean", "date", "instant", "range<date>", "range<instant>", "temporal_range", "recurrence_rule", "entity_ref", "timezone", "enum", "person", "person_list", "record", "record_list"], "description": "LifeSpace CanonicalFieldType; External does not define a second field-type vocabulary." },',
    ),
    (
        '"title": { "type": "string" },\n          "type":',
        '"title": { "type": "string" },\n          "description": { "type": "string", "maxLength": 300 },\n          "required": { "type": "boolean" },\n          "immutable": { "type": "boolean" },\n          "readOnly": { "type": "boolean" },\n          "minLength": { "type": "integer", "minimum": 0 },\n          "maxLength": { "type": "integer", "minimum": 1 },\n          "minimum": { "type": "number" },\n          "maximum": { "type": "number" },\n          "targetModel": { "type": "string" },\n          "type":',
    ),
    (
        '"operators": { "type": "array", "items": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "isNull", "isNotNull"] } },',
        '"operators": { "type": "array", "items": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "within", "contains", "overlaps", "before", "after", "kindIs", "isNull", "isNotNull"] } },',
    ),
    (
        '"values": { "type": "array", "items": { "type": "string" } }',
        '"values": { "type": "array", "maxItems": 50, "items": { "type": "string" } }',
    ),
    (
        '"additionalProperties": { "type": ["string", "number", "boolean", "null"] },\n        "description": "Flattened fields are constrained by the current compatible External Model snapshot. No Native version or audit fields are fabricated."',
        '"additionalProperties": true,\n        "description": "Flattened dynamic field values are validated against the current Canonical Field Definition in the Space-local External snapshot. No Native version or audit fields are fabricated."',
    ),
    (
        '"ExternalWriteData": { "type": "object", "additionalProperties": { "type": ["string", "number", "boolean", "null"] } },',
        '"ExternalWriteData": { "type": "object", "additionalProperties": true },',
    ),
    (
        '"properties": { "field": { "type": "string" }, "op": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "isNull", "isNotNull"] }, "value": { "type": ["string", "number", "boolean"] } }',
        '"properties": { "field": { "type": "string" }, "op": { "enum": ["eq", "ne", "lt", "lte", "gt", "gte", "within", "contains", "overlaps", "before", "after", "kindIs", "isNull", "isNotNull"] }, "value": { "description": "Canonical Query operand shape is determined by the selected canonical field type and advertised operator." } }',
    ),
]

for old, new in replacements:
    if old not in base:
        raise SystemExit(f"missing expected External OpenAPI fragment: {old}")
    base = base.replace(old, new, 1)

path.write_text(base)

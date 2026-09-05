import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OPENAPI = ROOT / "openapi.yaml"
CHECK = ROOT / "scripts" / "check-openapi.mjs"

with OPENAPI.open("r", encoding="utf-8") as handle:
    document = json.load(handle)

document["info"]["version"] = "0.23.0"
document["components"]["schemas"]["StatusResponse"]["properties"]["data"]["properties"]["contractVersion"] = {"const": "0.23.0"}

schemas = document["components"]["schemas"]
schemas["RuntimeDiscoveryRelationLookupSupported"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["supported", "method", "pathTemplate", "searchParameter", "cursorParameter", "limitParameter"],
    "properties": {
        "supported": {"const": True},
        "method": {"const": "GET"},
        "pathTemplate": {"const": "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"},
        "searchParameter": {"const": "q"},
        "cursorParameter": {"const": "cursor"},
        "limitParameter": {"const": "limit"},
    },
}
schemas["RuntimeDiscoveryRelationLookupUnsupported"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["supported", "reason"],
    "properties": {
        "supported": {"const": False},
        "reason": {"const": "reference-label-unavailable"},
    },
}
schemas["RuntimeDiscoveryRelation"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["targetModel", "cardinality", "lookup"],
    "properties": {
        "targetModel": {"type": "string", "minLength": 1},
        "cardinality": {"type": "string", "enum": ["one", "many"]},
        "lookup": {
            "oneOf": [
                {"$ref": "#/components/schemas/RuntimeDiscoveryRelationLookupSupported"},
                {"$ref": "#/components/schemas/RuntimeDiscoveryRelationLookupUnsupported"},
            ]
        },
    },
}
schemas["RuntimeDiscoveryField"]["properties"]["relation"] = {"$ref": "#/components/schemas/RuntimeDiscoveryRelation"}

schemas["RelationTarget"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "label"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        "label": {"type": "string", "minLength": 1},
    },
}
schemas["RelationTargetPage"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items", "nextCursor"],
    "properties": {
        "items": {"type": "array", "items": {"$ref": "#/components/schemas/RelationTarget"}},
        "nextCursor": {"anyOf": [{"type": "string"}, {"type": "null"}]},
    },
}
schemas["RelationTargetLookupResponse"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["data"],
    "properties": {"data": {"$ref": "#/components/schemas/RelationTargetPage"}},
}

document["paths"]["/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"] = {
    "parameters": [
        {"$ref": "#/components/parameters/SpaceId"},
        {"$ref": "#/components/parameters/ModelKey"},
        {
            "name": "fieldKey",
            "in": "path",
            "required": True,
            "schema": {"type": "string", "pattern": "^[a-z][A-Za-z0-9]{0,62}$"},
        },
    ],
    "get": {
        "tags": ["Runtime Discovery"],
        "operationId": "listRelationTargets",
        "description": (
            "Returns a source-field-aware, current-authority relation target projection for generated clients. "
            "The caller must have current read authority to the source model; model-collection Data Grants are sufficient and Space membership-management authority is not required. "
            "Person relations return only minimal structurally reference-eligible {id,label} references for active Space People and do not expose membership role or global user identity. "
            "This lookup is not proof of mutation authority: create/update Policy, relation integrity and all current authorization are rechecked when the mutation executes. "
            "record/record_list lookup is currently unsupported until canonical record reference-label semantics are defined."
        ),
        "parameters": [
            {"name": "q", "in": "query", "required": False, "schema": {"type": "string", "maxLength": 100}},
            {"name": "cursor", "in": "query", "required": False, "schema": {"type": "string"}},
            {"name": "limit", "in": "query", "required": False, "schema": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50}},
        ],
        "responses": {
            "200": {"description": "Minimal authorized relation targets", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/RelationTargetLookupResponse"}}}},
            "400": {"$ref": "#/components/responses/InvalidRequest"},
            "401": {"$ref": "#/components/responses/Unauthorized"},
            "403": {"$ref": "#/components/responses/Forbidden"},
            "404": {"$ref": "#/components/responses/NotFound"},
            "409": {"$ref": "#/components/responses/Conflict"},
        },
    },
}

with OPENAPI.open("w", encoding="utf-8") as handle:
    json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")

check = CHECK.read_text(encoding="utf-8")

def replace_once(old: str, new: str) -> None:
    global check
    if check.count(old) != 1:
        raise RuntimeError(f"expected exactly one contract-check anchor, found {check.count(old)}: {old[:100]!r}")
    check = check.replace(old, new)

replace_once(
    'document.info?.version !== "0.22.0"',
    'document.info?.version !== "0.23.0"',
)
replace_once(
    '  "/api/v1/spaces/{spaceId}/_discovery",\n',
    '  "/api/v1/spaces/{spaceId}/_discovery",\n  "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}",\n',
)
replace_once(
    'if (schemas.RuntimeDiscoveryField?.properties?.title?.type !== "string"\n    || schemas.RuntimeDiscoveryField?.properties?.title?.maxLength !== 80) {\n  throw new Error("Runtime Discovery fields must expose bounded JSON Schema-aligned title metadata");\n}\n',
    'if (schemas.RuntimeDiscoveryField?.properties?.title?.type !== "string"\n    || schemas.RuntimeDiscoveryField?.properties?.title?.maxLength !== 80) {\n  throw new Error("Runtime Discovery fields must expose bounded JSON Schema-aligned title metadata");\n}\n'
    'if (schemas.RuntimeDiscoveryField?.properties?.relation?.$ref !== "#/components/schemas/RuntimeDiscoveryRelation"\n'
    '    || schemas.RuntimeDiscoveryRelation?.additionalProperties !== false\n'
    '    || JSON.stringify(schemas.RuntimeDiscoveryRelation?.properties?.cardinality?.enum) !== JSON.stringify(["one", "many"])) {\n'
    '  throw new Error("Runtime Discovery relation metadata must expose bounded target/cardinality semantics");\n'
    '}\n'
    'const relationLookup = document.paths?.["/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"]?.get;\n'
    'const relationLookupSupported = schemas.RuntimeDiscoveryRelationLookupSupported;\n'
    'const relationLookupUnsupported = schemas.RuntimeDiscoveryRelationLookupUnsupported;\n'
    'if (!relationLookup?.description?.includes("source-field-aware")\n'
    '    || !relationLookup?.description?.includes("not proof of mutation authority")\n'
    '    || relationLookup?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RelationTargetLookupResponse"\n'
    '    || relationLookupSupported?.properties?.supported?.const !== true\n'
    '    || relationLookupSupported?.properties?.method?.const !== "GET"\n'
    '    || relationLookupSupported?.properties?.pathTemplate?.const !== "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"\n'
    '    || relationLookupSupported?.properties?.searchParameter?.const !== "q"\n'
    '    || relationLookupSupported?.properties?.cursorParameter?.const !== "cursor"\n'
    '    || relationLookupSupported?.properties?.limitParameter?.const !== "limit"\n'
    '    || relationLookupUnsupported?.properties?.supported?.const !== false\n'
    '    || relationLookupUnsupported?.properties?.reason?.const !== "reference-label-unavailable") {\n'
    '  throw new Error("Relation target lookup contract drifted");\n'
    '}\n'
    'if (schemas.RelationTarget?.additionalProperties !== false\n'
    '    || JSON.stringify(schemas.RelationTarget?.required) !== JSON.stringify(["id", "label"])\n'
    '    || schemas.RelationTargetPage?.properties?.items?.items?.$ref !== "#/components/schemas/RelationTarget") {\n'
    '  throw new Error("Relation target projection must remain minimal id/label data");\n'
    '}\n',
)
replace_once(
    'schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.22.0"',
    'schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.23.0"',
)

CHECK.write_text(check, encoding="utf-8")

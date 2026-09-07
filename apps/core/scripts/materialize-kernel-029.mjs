import { readFileSync, writeFileSync } from "node:fs";

const output = process.argv[2] ?? "/tmp/core-openapi-029.yaml";
const path = new URL("../openapi.yaml", import.meta.url);
const document = JSON.parse(readFileSync(path, "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.28.0") {
  throw new Error("Expected Core Kernel OpenAPI 0.28.0 as the materialization source");
}

document.info.version = "0.29.0";
document.info.description = "Stable LifeSpace Core Kernel contract for Space, membership, invitations, Data Grants, Agent Delegations, governed Change History, authorized Runtime Discovery with bounded Capability field-role bindings plus canonical Person/ordinary-record Reference Projection, webhook endpoints, event subscriptions, model administration, assets and Registry-driven Creation Draft orchestration. Ordinary business-model routes are intentionally not declared here; each published Model Registry state produces an immutable Model Contract Revision (mct_<sha256>) containing its concrete CRUD/query/action/Capability OpenAPI and JSON Schema.";

document.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.29.0";

const referenceLabelSchema = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "fallback", "maxLength"],
      properties: {
        mode: { const: "id" },
        fallback: { const: "id" },
        maxLength: { const: 200 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "field", "fallback", "maxLength"],
      properties: {
        mode: { const: "field" },
        field: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,62}$" },
        fallback: { const: "id" },
        maxLength: { const: 200 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["mode", "template", "fields", "fallback", "maxLength"],
      properties: {
        mode: { const: "template" },
        template: { type: "string", minLength: 1, maxLength: 200 },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          uniqueItems: true,
          items: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,62}$" },
        },
        fallback: { const: "id" },
        maxLength: { const: 200 },
      },
    },
  ],
  description: "Canonical model-owned minimal label semantics for ordinary-record references. mode=id is the stable fallback when no explicit referenceLabel is declared. field/template modes project only declared scalar fields; blank projections fall back to the record ID. This is semantic Reference Projection, not record identity, UI layout or mutation authority.",
};
document.components.schemas.RuntimeReferenceLabelSemantic = referenceLabelSchema;

for (const schemaName of ["RuntimeDiscoveryModel", "RuntimeModelSemanticDetail"]) {
  const schema = document.components.schemas[schemaName];
  if (!schema) throw new Error(`Missing ${schemaName}`);
  if (!schema.required.includes("referenceLabel")) schema.required.push("referenceLabel");
  schema.properties.referenceLabel = { $ref: "#/components/schemas/RuntimeReferenceLabelSemantic" };
}

const lookupPath = document.paths["/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"]?.get;
if (!lookupPath) throw new Error("Missing Relation Target Lookup route");
lookupPath.description = "Returns a source-field-aware, current-authority relation target projection for generated clients. The caller must have current read authority to the source model; model-collection Data Grants are sufficient and Space membership-management authority is not required. Person relations return only minimal structurally reference-eligible {id,label} references for active Space People. record/record_list relations use the target Model's canonical referenceLabel semantics (or stable record ID fallback) and additionally require current read authority to that target Model. Search and pagination use the same canonical label. This lookup exposes no membership role/global user identity and is not proof of mutation authority: create/update Policy, relation integrity and all current authorization are rechecked when the mutation executes.";

const resolutionPath = document.paths["/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}"]?.post;
if (!resolutionPath) throw new Error("Missing Reference Resolution route");
resolutionPath.description = "Resolves a bounded set of existing relation IDs for one source model field under the caller's current source-model read authority. Results preserve input order and duplicates. Each valid input ID returns either resolved with the minimal current label or opaque unavailable; unavailable intentionally does not distinguish missing, deleted, hidden, forbidden, wrong-Space or otherwise non-resolvable references. Person/person_list resolve through active same-Space Space Person displayName. record/record_list resolve through the target Model's canonical referenceLabel semantics (or stable record ID fallback) and additionally require current target-model read authority. Resolution is Context Projection and never proves mutation authority: create/update Policy, relation integrity and all current authorization are rechecked when a mutation executes.";

const referenceIds = document.components.schemas.ReferenceResolutionRequest.properties.ids.items;
referenceIds.pattern = "^(?:per|rec)_[A-Za-z0-9_-]+$";
referenceIds.maxLength = 200;
referenceIds.description = "Reference ID kind is determined by the source relation field: per_* for Person relations and rec_* for ordinary-record relations.";

writeFileSync(output, JSON.stringify(document));
console.log(JSON.stringify({ output, version: document.info.version, referenceLabel: true, recordReferenceResolution: true }));

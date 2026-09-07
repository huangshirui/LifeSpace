import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = process.argv[2] ?? "/tmp/lifespace-kernel-029-final";

function repoPath(relative) {
  return join(ROOT, relative);
}

function read(relative) {
  return readFileSync(repoPath(relative), "utf8");
}

function write(relative, content) {
  writeFileSync(repoPath(relative), content, "utf8");
}

function replaceOnce(relative, before, after) {
  const content = read(relative);
  const first = content.indexOf(before);
  if (first === -1) throw new Error(`${relative}: expected text not found: ${before.slice(0, 120)}`);
  if (content.indexOf(before, first + before.length) !== -1) {
    throw new Error(`${relative}: expected text occurs more than once: ${before.slice(0, 120)}`);
  }
  write(relative, content.slice(0, first) + after + content.slice(first + before.length));
}

function insertAfter(relative, marker, addition) {
  replaceOnce(relative, marker, `${marker}${addition}`);
}

{
  const relative = "apps/core/openapi.yaml";
  const document = JSON.parse(read(relative));
  if (document.openapi !== "3.1.0" || document.info?.version !== "0.28.0") {
    throw new Error("Expected Core Kernel OpenAPI 0.28.0 as the finalization source");
  }

  document.info.version = "0.29.0";
  document.info.description = "Stable LifeSpace Core Kernel contract for Space, membership, invitations, Data Grants, Agent Delegations, governed Change History, authorized Runtime Discovery with bounded Capability field-role bindings plus canonical Person/ordinary-record Reference Projection, webhook endpoints, event subscriptions, model administration, assets and Registry-driven Creation Draft orchestration. Ordinary business-model routes are intentionally not declared here; each published Model Registry state produces an immutable Model Contract Revision (mct_<sha256>) containing its concrete CRUD/query/action/Capability OpenAPI and JSON Schema.";
  document.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.29.0";

  document.components.schemas.RuntimeReferenceLabelSemantic = {
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

  write(relative, JSON.stringify(document));
}

replaceOnce("apps/core/src/app.ts", 'contractVersion: "0.28.0"', 'contractVersion: "0.29.0"');
replaceOnce("apps/core/package.json", '"version": "0.28.0"', '"version": "0.29.0"');
replaceOnce("apps/core/AGENTS.md", "current Kernel version: 0.28.0", "current Kernel version: 0.29.0");
replaceOnce("apps/core/README.md", "The current business-facing Core Kernel contract is **0.28.0**.", "The current business-facing Core Kernel contract is **0.29.0**.");
insertAfter(
  "apps/core/README.md",
  "- `GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}` — progressive static semantic detail for one currently visible model;\n",
  "- `GET /api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}` — bounded current relation target selection using canonical Person `displayName` or ordinary-record `referenceLabel` semantics under current source/target Model authority;\n",
);
replaceOnce(
  "apps/core/README.md",
  "- `POST /api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}` — bounded source-field-aware hydration of existing relation IDs into minimal current labels with opaque per-item unavailable results.",
  "- `POST /api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}` — bounded source-field-aware hydration of existing Person or ordinary-record relation IDs into minimal current labels with opaque per-item unavailable results.",
);

replaceOnce("apps/core/scripts/check-openapi.mjs", 'document.info?.version !== "0.28.0"', 'document.info?.version !== "0.29.0"');
replaceOnce(
  "apps/core/scripts/check-openapi.mjs",
  'schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.28.0"',
  'schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.29.0"',
);
replaceOnce(
  "apps/core/scripts/check-openapi.mjs",
  '  "fields", "key", "query", "route", "schemaHash", "version",',
  '  "fields", "key", "query", "referenceLabel", "route", "schemaHash", "version",',
);
insertAfter(
  "apps/core/scripts/check-openapi.mjs",
  `if (schemas.RuntimeDiscoveryField?.properties?.relation?.$ref !== "#/components/schemas/RuntimeDiscoveryRelation"\n    || schemas.RuntimeDiscoveryRelation?.additionalProperties !== false\n    || JSON.stringify(schemas.RuntimeDiscoveryRelation?.properties?.cardinality?.enum) !== JSON.stringify(["one", "many"])) {\n  throw new Error("Runtime Discovery relation metadata must expose bounded target/cardinality semantics");\n}\n`,
  `const referenceLabelSemantic = schemas.RuntimeReferenceLabelSemantic;\nif (referenceLabelSemantic?.oneOf?.length !== 3\n    || referenceLabelSemantic.oneOf[0]?.properties?.mode?.const !== "id"\n    || referenceLabelSemantic.oneOf[1]?.properties?.mode?.const !== "field"\n    || referenceLabelSemantic.oneOf[2]?.properties?.mode?.const !== "template"\n    || referenceLabelSemantic.oneOf[2]?.properties?.fields?.maxItems !== 8\n    || referenceLabelSemantic.oneOf[2]?.properties?.template?.maxLength !== 200) {\n  throw new Error("Runtime reference-label semantic contract drifted");\n}\nfor (const schemaName of ["RuntimeDiscoveryModel", "RuntimeModelSemanticDetail"]) {\n  const schema = schemas[schemaName];\n  if (!schema?.required?.includes("referenceLabel")\n      || schema?.properties?.referenceLabel?.$ref !== "#/components/schemas/RuntimeReferenceLabelSemantic") {\n    throw new Error(schemaName + " must expose canonical reference-label semantics");\n  }\n}\n`,
);
insertAfter(
  "apps/core/scripts/check-openapi.mjs",
  `const referenceResolution = document.paths?.["/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}"]?.post;\n`,
  `const referenceResolutionId = schemas.ReferenceResolutionRequest?.properties?.ids?.items;\nif (referenceResolutionId?.pattern !== "^(?:per|rec)_[A-Za-z0-9_-]+$"\n    || referenceResolutionId?.maxLength !== 200) {\n  throw new Error("Reference Resolution must accept bounded Person and ordinary-record IDs according to the source relation kind");\n}\n`,
);
insertAfter(
  "apps/core/scripts/check-openapi.mjs",
  `if (referenceResolution?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ReferenceResolutionRequest"\n    || referenceResolution?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ReferenceResolutionResponse"\n    || !referenceResolution?.description?.includes("opaque unavailable")\n    || !referenceResolution?.description?.includes("never proves mutation authority")) {\n  throw new Error("Reference Resolution must remain bounded, opaque and non-authoritative");\n}\n`,
  `if (!referenceResolution?.description?.includes("record/record_list")\n    || !referenceResolution?.description?.includes("target-model read authority")) {\n  throw new Error("Reference Resolution must document canonical ordinary-record projection and target Model authority");\n}\n`,
);
insertAfter(
  "apps/core/scripts/check-openapi.mjs",
  `if (!relationLookup?.description?.includes("source-field-aware")\n    || !relationLookup?.description?.includes("not proof of mutation authority")\n    || relationLookup?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RelationTargetLookupResponse"\n    || relationLookupSupported?.properties?.supported?.const !== true\n    || relationLookupSupported?.properties?.method?.const !== "GET"\n    || relationLookupSupported?.properties?.pathTemplate?.const !== "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"\n    || relationLookupSupported?.properties?.searchParameter?.const !== "q"\n    || relationLookupSupported?.properties?.cursorParameter?.const !== "cursor"\n    || relationLookupSupported?.properties?.limitParameter?.const !== "limit"\n    || relationLookupUnsupported?.properties?.supported?.const !== false\n    || relationLookupUnsupported?.properties?.reason?.const !== "reference-label-unavailable") {\n  throw new Error("Relation target lookup contract drifted");\n}\n`,
  `if (!relationLookup?.description?.includes("record/record_list")\n    || !relationLookup?.description?.includes("target Model")) {\n  throw new Error("Relation Target Lookup must document canonical ordinary-record projection and target Model authority");\n}\n`,
);

replaceOnce(
  "docs/model-definition-spec.md",
  "  fields: Record<string, FieldDefinition>,\n  defaults?: Record<string, DefaultValue>,",
  "  fields: Record<string, FieldDefinition>,\n  referenceLabel?: { field: string } | { template: string },\n  defaults?: Record<string, DefaultValue>,",
);
replaceOnce(
  "docs/model-definition-spec.md",
  "Relation metadata defines **what may be referenced structurally**, not a static list of current target instances. Generated JSON Schema therefore projects stable relation target/cardinality through `x-lifespace-relation` and must not encode mutable Space-specific targets as `enum`. Runtime Discovery / Relation Target Lookup may resolve current targets under current authorization for clients such as n8n, Agents/MCP and generated UI. A lookup result is a capability/reference projection only: it does not bypass create/update Policy or mutation-time relation validation. `person` / `person_list` have canonical Space Person labels (`displayName`) and can be resolved generically; `record` / `record_list` remain lookup-unsupported until a canonical record reference-label semantic is defined rather than guessed from model-specific field names.",
  "Relation metadata defines **what may be referenced structurally**, not a static list of current target instances. Generated JSON Schema therefore projects stable relation target/cardinality through `x-lifespace-relation` and must not encode mutable Space-specific targets as `enum`. Runtime Discovery / Relation Target Lookup may resolve current targets under current authorization for clients such as n8n, Agents/MCP and generated UI. A lookup result is a capability/reference projection only: it does not bypass create/update Policy or mutation-time relation validation. `person` / `person_list` use the canonical Space Person `displayName`. `record` / `record_list` use the target Model's canonical `referenceLabel` semantics defined below, with stable record ID fallback. Record lookup/resolution additionally requires current read authority to the target Model; adapters must never infer labels from conventional field names such as `name`, `title` or `summary`.",
);
insertAfter(
  "docs/model-definition-spec.md",
  "Conformance-ID: MDV1-RELATION-STRUCTURE-01\n\n",
  `### 4.2.1 \`referenceLabel\`\n\n\`referenceLabel\` defines the model-owned minimal human-readable label used when an ordinary record is referenced by another model. It is semantic Reference Projection for generic clients, not record identity, UI layout, search ranking or mutation authority.\n\nV1 supports exactly one of:\n\n\`\`\`ts\nreferenceLabel: { field: "name" }\n\nreferenceLabel: { template: "{code} · {name}" }\n\`\`\`\n\nRules:\n\n- the object must contain exactly one of \`field\` or \`template\`;\n- referenced fields must exist and must be scalar \`string\`, \`text\`, \`integer\`, \`number\`, \`boolean\`, \`date\`, \`datetime\`, \`timezone\` or \`enum\` fields; relation fields are not valid label inputs;\n- a template is trimmed, contains 1–200 characters, uses only simple \`{field}\` placeholders and contains at most eight placeholders; at least one placeholder is required;\n- rendered output is trimmed and limited to 200 characters; boolean values render as \`true\` / \`false\`;\n- when \`referenceLabel\` is omitted, or when every referenced value is null/blank so the projected label is empty, the stable record ID is the canonical fallback;\n- Relation Target Lookup search/pagination and Batch Reference Resolution must use the same canonical label projection;\n- changing, adding or removing \`referenceLabel\` on an already-published model is a breaking semantic compatibility change because generic consumers may observe different labels/search ordering;\n- adapters must not override this semantic by guessing conventional fields such as \`name\`, \`title\` or \`summary\`.\n\nConformance-ID: MDV1-REFERENCE-LABEL-01\n\n`,
);

replaceOnce("docs/contracts.md", "As of Core Kernel `0.28.0`, ordinary model paths/schemas remain deliberately absent", "As of Core Kernel `0.29.0`, ordinary model paths/schemas remain deliberately absent");
insertAfter(
  "docs/contracts.md",
  "Kernel `0.28.0` adds bounded source-field-aware batch Reference Resolution for existing relation IDs: Person references resolve to minimal same-Space active Space Person labels, each valid input ID returns only `resolved` or opaque `unavailable`, input order/duplicates are preserved, and record/reference hydration remains explicitly unsupported until canonical ordinary-record label semantics exist.",
  " Kernel `0.29.0` adds model-owned canonical ordinary-record `referenceLabel` semantics, exposes them in Runtime Discovery and progressive static detail, and enables `record` / `record_list` Relation Target Lookup plus Batch Reference Resolution using that same projection. Missing/blank label input falls back to stable record ID; record lookup/resolution additionally rechecks current read authority to the target Model, and all writes still recheck mutation-time authority, Policy and relation integrity.",
);
insertAfter("docs/contracts.md", "- relation identifiers;\n", "- model-owned canonical ordinary-record reference-label semantics;\n");
insertAfter(
  "docs/contracts.md",
  "Kernel `0.23.0` extends this projection with relation-target resolution. A relation field's stable structural semantics remain in Model Definition / generated JSON Schema (`targetModel` + cardinality); Runtime Discovery adds whether the current relation kind has a generic target lookup. For `person` / `person_list`, `GET /api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}` returns only active Space Person `{id,label}` references under the caller's current source-model read authority, with bounded search and cursor pagination. The result does not expose membership roles/global user IDs and does not establish mutation authority: create/update policies and relation integrity are rechecked when a write executes. Dynamic relation targets are therefore never serialized as static JSON Schema `enum` values.\n",
  "\nKernel `0.29.0` extends the same relation projection to `record` / `record_list`. Each target Model owns one canonical `referenceLabel` semantic (`field`, bounded simple `template`, or stable record-ID fallback when omitted/blank). The label is projected consistently into Runtime Discovery/static detail, Relation Target Lookup and Batch Reference Resolution. Ordinary-record lookup/resolution requires current source-model read authority **and** current target-model read authority, so a source relation never becomes a label-disclosure side channel.\n",
);
replaceOnce("docs/architecture.md", "current Kernel contract: 0.28.0", "current Kernel contract: 0.29.0");
replaceOnce(
  "docs/architecture.md",
  "Record-relation lookup remains explicitly unavailable until LifeSpace has canonical record reference-label semantics instead of adapter heuristics such as guessing `name`, `title` or `summary`.",
  "Kernel `0.29.0` adds model-owned canonical record `referenceLabel` semantics so `record` / `record_list` lookup and hydration no longer depend on adapter heuristics such as guessing `name`, `title` or `summary`. The same projection is used for lookup search/pagination and batch resolution, falls back to stable record ID when no usable label value exists, and additionally requires current target-model read authority to prevent cross-model label disclosure.",
);
insertAfter("docs/phase3-metadata-platform-plan.md", "- field definitions;\n", "- optional canonical ordinary-record reference-label semantics for generic relation projection;\n");

replaceOnce("docs/generic-consumer-reference-resolution.md", "Kernel contract: **0.28.0**", "Kernel contract: **0.29.0**");
replaceOnce("docs/generic-consumer-reference-resolution.md", "Ordinary-record label dependency: #155", "Ordinary-record label semantics: #155 (implemented by Kernel 0.29.0)");
replaceOnce(
  "docs/generic-consumer-reference-resolution.md",
  "This document fixes the first HTTP representation for the already-accepted M2 Batch Reference Resolution / Hydration semantic. It does not redefine Relation Target Lookup, Model Definition semantics, reference-label semantics or mutation authority.",
  "This document fixes the HTTP representation for the already-accepted M2 Batch Reference Resolution / Hydration semantic and records the Kernel 0.29 composition with #155 canonical ordinary-record reference-label semantics. It does not redefine mutation authority: lookup/resolution remain Context Projection only.",
);
replaceOnce(
  "docs/generic-consumer-reference-resolution.md",
  "- each item is a non-empty string valid for the source relation kind (`^per_` for Person v1);",
  "- each item is a non-empty string valid for the source relation kind (`per_*` for `person` / `person_list`, `rec_*` for `record` / `record_list`);",
);
replaceOnce(
  "docs/generic-consumer-reference-resolution.md",
  "`record` and `record_list` resolution remain field-level unsupported until #155 defines canonical ordinary-record reference-label semantics.\n\nThe stable reason is:\n\n```text\nreference-label-unavailable\n```\n\nCore and adapters MUST NOT infer a record label from conventional fields such as `title`, `name` or `summary`.",
  "`record` and `record_list` are supported in Kernel 0.29.0. The source relation declares the target Model; Core resolves target records only in the same Space and only while the caller has current read authority to both the source Model projection and the target Model.\n\nThe target Model owns the canonical label through Model Definition `referenceLabel`:\n\n- `{ field: \"name\" }` projects one declared scalar field;\n- `{ template: \"{code} · {name}\" }` projects a bounded simple template;\n- omitted `referenceLabel`, or an empty projection because all referenced values are null/blank, falls back to the stable `rec_*` record ID.\n\nLookup search/pagination and Batch Reference Resolution use the same canonical label. Core and adapters MUST NOT infer or override labels from conventional field names such as `title`, `name` or `summary`.",
);
replaceOnce(
  "docs/generic-consumer-reference-resolution.md",
  "For `record` / `record_list`, `resolution.supported=false` with `reason=reference-label-unavailable` until #155. This projection is discoverable semantic/context information, not authorization proof.",
  "For `record` / `record_list`, lookup and resolution are supported and use the target Model's canonical `referenceLabel` semantic or stable record-ID fallback. The descriptors remain discoverable semantic/context information, not authorization proof; each request independently rechecks current source authority and current target-model read authority.",
);

replaceOnce(
  "docs/generic-consumer-m4-acceptance.md",
  "## 7. Remaining work outside #165\n\nThe following remain intentionally separate and do not reopen Generic Consumer Readiness v1:\n\n- **#155** — canonical ordinary-record reference label semantics. Until it lands, `record` / `record_list` generic label lookup/resolution remains explicitly unsupported rather than guessed from fields such as `name` or `title`.\n- **#130** — stronger schema-aware Stable Public OpenAPI compatibility diff gate.\n- **lifespace-n8n-nodes#22** — adopt compact inventory + selected model detail.\n- **lifespace-adapters#4** — make progressive inventory/detail the default MCP discovery input when MCP implementation proceeds.",
  "## 7. Follow-up status outside #165\n\n**#155 is resolved by Kernel 0.29.0.** Ordinary-record canonical reference labels are now model-owned and `record` / `record_list` generic lookup/resolution is supported without field-name guessing. This closes the cross-consumer semantic gap identified after M4 without reopening #165.\n\nThe following remain intentionally separate:\n\n- **#130** — stronger schema-aware Stable Public OpenAPI compatibility diff gate.\n- **lifespace-n8n-nodes#22** — adopt compact inventory + selected model detail.\n- **lifespace-adapters#4** — make progressive inventory/detail the default MCP discovery input when MCP implementation proceeds.",
);

const finalized = [
  "apps/core/openapi.yaml",
  "apps/core/src/app.ts",
  "apps/core/package.json",
  "apps/core/AGENTS.md",
  "apps/core/README.md",
  "apps/core/scripts/check-openapi.mjs",
  "docs/model-definition-spec.md",
  "docs/contracts.md",
  "docs/architecture.md",
  "docs/phase3-metadata-platform-plan.md",
  "docs/generic-consumer-reference-resolution.md",
  "docs/generic-consumer-m4-acceptance.md",
];

rmSync(OUT, { recursive: true, force: true });
for (const relative of finalized) {
  const target = join(OUT, relative);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(repoPath(relative), target);
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ kernel: "0.29.0", files: finalized }, null, 2));
console.log(JSON.stringify({ ok: true, kernel: "0.29.0", out: OUT, files: finalized.length }));

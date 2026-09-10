import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

async function read(path) {
  return readFile(resolve(root, path), "utf8");
}

async function write(path, content) {
  await writeFile(resolve(root, path), content, "utf8");
}

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`Missing migration anchor: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous migration anchor: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

async function replaceFileOnce(path, before, after, label = path) {
  const current = await read(path);
  await write(path, replaceOnce(current, before, after, label));
}

// Normative Model Definition v1 semantics.
{
  const path = "docs/model-definition-spec.md";
  let text = await read(path);
  text = replaceOnce(
    text,
    "`apps/core/src/model-definition.ts`, `policy-definition.ts`, `workflow-definition.ts` and `capability-definition.ts` are the machine validators and must remain aligned with this specification;",
    "`apps/core/src/model-definition.ts`, `time-range-definition.ts`, `policy-definition.ts`, `workflow-definition.ts` and `capability-definition.ts` are the machine validators and must remain aligned with this specification;",
    "spec validator ownership",
  );
  text = replaceOnce(text, "A Model Definition answers six different questions:", "A Model Definition answers seven different questions:", "spec mental-model count");
  text = replaceOnce(
    text,
    `Model\n├── Fields       — what data does this thing contain?\n├── Query        — how may clients find it?\n├── Access       — what model-level operation classes exist?\n├── Policy       — who may perform an otherwise-authorized operation?\n├── Actions      — what model-specific semantic changes can be invoked?\n└── Capabilities — which reusable cross-model semantic packages does it conform to?`,
    `Model\n├── Fields       — what data does this thing contain?\n├── Time Ranges  — which date/datetime fields form semantic intervals?\n├── Query        — how may clients find it?\n├── Access       — what model-level operation classes exist?\n├── Policy       — who may perform an otherwise-authorized operation?\n├── Actions      — what model-specific semantic changes can be invoked?\n└── Capabilities — which reusable cross-model semantic packages does it conform to?`,
    "spec mental-model tree",
  );
  text = replaceOnce(
    text,
    "- **字段（Field）** describes state.\n- **CRUD** is the generic transport for ordinary state access/change.",
    "- **字段（Field）** describes state.\n- **时间范围（Time Range）** groups two declared date/datetime fields into one structural interval semantic; it is not itself a query operator.\n- **CRUD** is the generic transport for ordinary state access/change.",
    "spec time-range concept",
  );
  text = replaceOnce(
    text,
    "  fields: Record<string, FieldDefinition>,\n  referenceLabel?: { field: string } | { template: string },",
    `  fields: Record<string, FieldDefinition>,\n  timeRanges?: Record<string, {\n    startField: string,\n    endField: string,\n    bounds?: "[]" | "[)" | "(]" | "()"\n  }>,\n  referenceLabel?: { field: string } | { template: string },`,
    "spec top-level timeRanges",
  );
  const rangeSection = `### 4.4 \`timeRanges\`\n\n\`timeRanges\` declares model-owned **structural interval semantics** for pairs of already-declared \`date\` or \`datetime\` fields. It lets generic consumers understand that two otherwise independent fields represent the start and end of the same semantic range without guessing from names such as \`startAt\`, \`endAt\`, \`validFrom\` or \`validUntil\`.\n\nExample:\n\n\`\`\`ts\ntimeRanges: {\n  validity: {\n    startField: "validFrom",\n    endField: "validUntil",\n    bounds: "[)"\n  }\n}\n\`\`\`\n\nRules:\n\n- \`timeRanges\` is optional; when present it must be a non-empty object with at most 16 entries;\n- range keys use the normal field-style semantic-key syntax \`^[a-z][A-Za-z0-9]{0,62}$\`;\n- \`startField\` and \`endField\` must both exist, must be distinct, and must be either \`date/date\` or \`datetime/datetime\`; mixed \`date/datetime\` pairs are invalid;\n- \`bounds\` may be \`[]\`, \`[)\`, \`(]\` or \`()\`; omission means the canonical half-open form \`[)\`, and validation normalizes the published definition to that explicit value;\n- the same unordered field pair may not be declared twice, including a reversed duplicate, because that would create ambiguous structural semantics;\n- Calendar Capability bindings remain authoritative for Calendar timed and all-day intervals. A model with Calendar must not redeclare the Calendar-owned \`timedStartField/timedEndField\` or \`allDayStartField/allDayEndExclusiveField\` pair in \`timeRanges\`; progressive semantic projection derives those ranges directly from the Capability binding;\n- declaring a range does **not** automatically add \`overlaps\`, \`contains\`, \`before\` or any other query operator. Query capability remains separately and explicitly declared/versioned;\n- declaring a range does **not** by itself add a new create/update ordering invariant such as \`start < end\`. Record-value validation remains whatever the model/Capability already owns until a future semantic rule explicitly introduces such an invariant;\n- adding, removing or changing \`timeRanges\` on an already-published model is a breaking semantic compatibility change because generic consumers may change how they interpret the participating fields;\n- progressive static semantic detail may project a derived \`valueType\` plus \`source\` metadata for consumers. Those projection fields are derived facts, not additional editable Model Definition properties.\n\nConformance-ID: MDV1-TIME-RANGES-01\n\n`;
  text = replaceOnce(text, "## 5. Defaults\n", rangeSection + "## 5. Defaults\n", "spec timeRanges normative section");
  text = replaceOnce(
    text,
    "For filterable `date`, `datetime`, `integer` and `number` fields, the generated query surface also supports `FieldFrom` / `FieldTo` style range parameters.\n\nCapabilities may add their own semantic query parameters.",
    "For filterable `date`, `datetime`, `integer` and `number` fields, the generated query surface also supports `FieldFrom` / `FieldTo` style range parameters. A `timeRanges` declaration remains independent structural metadata and does not imply any additional overlap/interval query syntax.\n\nCapabilities may add their own semantic query parameters.",
    "spec query separation",
  );
  await write(path, text);
}

// Kernel OpenAPI 0.33.0: progressive static semantic detail gains canonical timeRanges.
{
  const path = "apps/core/openapi.yaml";
  const document = JSON.parse(await read(path));
  if (document.info?.version !== "0.32.0") throw new Error(`Expected Kernel 0.32.0 before migration, found ${document.info?.version}`);
  document.info.version = "0.33.0";
  document.info.description = document.info.description.replace(
    "authorized Runtime Discovery with bounded Capability field-role bindings plus canonical Person/ordinary-record Reference Projection",
    "authorized Runtime Discovery with bounded Capability field-role bindings, canonical structural time-range semantics plus Person/ordinary-record Reference Projection",
  );
  document.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.33.0";

  const schemas = document.components.schemas;
  if (schemas.RuntimeModelSemanticTimeRange) throw new Error("RuntimeModelSemanticTimeRange already exists");
  schemas.RuntimeModelSemanticTimeRange = {
    type: "object",
    description: "Canonical structural date/datetime interval semantics. These facts do not themselves imply an overlap or other interval query operator.",
    additionalProperties: false,
    required: ["key", "startField", "endField", "valueType", "bounds", "source"],
    properties: {
      key: { type: "string", minLength: 1, maxLength: 80 },
      startField: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,62}$" },
      endField: { type: "string", pattern: "^[a-z][A-Za-z0-9]{0,62}$" },
      valueType: { type: "string", enum: ["date", "datetime"] },
      bounds: { type: "string", enum: ["[]", "[)", "(]", "()"] },
      source: { type: "string", enum: ["model", "capability"] },
      capability: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" },
    },
  };

  const detail = schemas.RuntimeModelSemanticDetail;
  if (detail.required.includes("timeRanges") || detail.properties.timeRanges) throw new Error("RuntimeModelSemanticDetail timeRanges already exists");
  const fieldIndex = detail.required.indexOf("fields");
  if (fieldIndex < 0) throw new Error("RuntimeModelSemanticDetail fields anchor missing");
  detail.required.splice(fieldIndex + 1, 0, "timeRanges");
  const projectedProperties = {};
  for (const [key, value] of Object.entries(detail.properties)) {
    projectedProperties[key] = value;
    if (key === "fields") {
      projectedProperties.timeRanges = {
        type: "array",
        items: { $ref: "#/components/schemas/RuntimeModelSemanticTimeRange" },
      };
    }
  }
  detail.properties = projectedProperties;

  const route = document.paths["/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"].get;
  route.description += " The static body includes canonical structural timeRanges facts; they describe interval meaning only and do not by themselves grant or imply an overlap query operator.";
  await write(path, JSON.stringify(document));
}

// Kernel contract checker follows the public representation.
{
  const path = "apps/core/scripts/check-openapi.mjs";
  let text = await read(path);
  const versionMatches = text.match(/0\.32\.0/g) ?? [];
  if (versionMatches.length !== 2) throw new Error(`Expected exactly two 0.32.0 checker references, found ${versionMatches.length}`);
  text = text.replaceAll("0.32.0", "0.33.0");
  text = replaceOnce(
    text,
    `const expectedSemanticDetailProperties = [\n  "actions", "capabilities", "capabilityBindings", "declaredAccess", "defaults", "description", "display",\n  "fields", "key", "query", "referenceLabel", "schemaHash", "version",\n].sort();`,
    `const expectedSemanticDetailProperties = [\n  "actions", "capabilities", "capabilityBindings", "declaredAccess", "defaults", "description", "display",\n  "fields", "key", "query", "referenceLabel", "schemaHash", "timeRanges", "version",\n].sort();`,
    "Kernel semantic detail property list",
  );
  const anchor = `if (schemas.RuntimeModelSemanticField?.properties?.relation?.$ref !== "#/components/schemas/RuntimeModelSemanticRelation"`;
  const assertion = `const semanticTimeRange = schemas.RuntimeModelSemanticTimeRange;\nif (!semanticDetail?.required?.includes("timeRanges")\n    || semanticDetail?.properties?.timeRanges?.type !== "array"\n    || semanticDetail?.properties?.timeRanges?.items?.$ref !== "#/components/schemas/RuntimeModelSemanticTimeRange"\n    || semanticTimeRange?.additionalProperties !== false\n    || JSON.stringify(semanticTimeRange?.required) !== JSON.stringify(["key", "startField", "endField", "valueType", "bounds", "source"])\n    || semanticTimeRange?.properties?.key?.maxLength !== 80\n    || semanticTimeRange?.properties?.startField?.pattern !== "^[a-z][A-Za-z0-9]{0,62}$"\n    || semanticTimeRange?.properties?.endField?.pattern !== "^[a-z][A-Za-z0-9]{0,62}$"\n    || JSON.stringify(semanticTimeRange?.properties?.valueType?.enum) !== JSON.stringify(["date", "datetime"])\n    || JSON.stringify(semanticTimeRange?.properties?.bounds?.enum) !== JSON.stringify(["[]", "[)", "(]", "()"])\n    || JSON.stringify(semanticTimeRange?.properties?.source?.enum) !== JSON.stringify(["model", "capability"])) {\n  throw new Error("Single-model semantic detail time-range contract drifted");\n}\n\n`;
  text = replaceOnce(text, anchor, assertion + anchor, "Kernel time-range checker insertion");
  await write(path, text);
}

await replaceFileOnce(
  "apps/core/src/app.ts",
  'contractVersion: "0.32.0"',
  'contractVersion: "0.33.0"',
  "Core status contract version",
);

{
  const path = "apps/core/package.json";
  const packageJson = JSON.parse(await read(path));
  if (packageJson.version !== "0.32.0") throw new Error(`Expected @lifespace/core 0.32.0, found ${packageJson.version}`);
  packageJson.version = "0.33.0";
  await write(path, `${JSON.stringify(packageJson, null, 2)}\n`);
}

await replaceFileOnce(
  "apps/core/AGENTS.md",
  "current Kernel version: 0.32.0",
  "current Kernel version: 0.33.0",
  "Core AGENTS current Kernel version",
);
await replaceFileOnce(
  "apps/core/README.md",
  "The current business-facing Core Kernel contract is **0.32.0**.",
  "The current business-facing Core Kernel contract is **0.33.0**. Progressive single-model semantic detail now includes canonical structural `timeRanges` projected from Model Definition declarations and registered Capability bindings; this metadata does not itself imply an interval query operator.",
  "Core README current Kernel version",
);
await replaceFileOnce(
  "docs/architecture.md",
  "current Kernel contract: 0.32.0",
  "current Kernel contract: 0.33.0",
  "architecture current Kernel version",
);
await replaceFileOnce(
  "README.md",
  "The current repository Core Kernel contract is **0.26.0**.",
  "The current repository Core Kernel contract is **0.33.0**.",
  "root README stale Kernel version",
);

{
  const path = "docs/contracts.md";
  let text = await read(path);
  text = replaceOnce(
    text,
    "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.32.0` owns neither Model Registry governance nor Eventing wire representation.",
    "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.33.0` owns neither Model Registry governance nor Eventing wire representation.",
    "contracts current Kernel version",
  );
  const historyAnchor = "As of Core Kernel `0.32.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`";
  const historyIndex = text.indexOf(historyAnchor);
  if (historyIndex < 0) throw new Error("Missing contracts 0.32.0 history anchor");
  const note = "Core Kernel `0.33.0` adds canonical structural `timeRanges` to progressive single-model semantic detail. Model-declared ranges and Calendar-derived timed/all-day ranges are projected from their authoritative semantic sources; the projection does not itself introduce overlap/interval query syntax. The Model Control Plane remains independently versioned because its `ModelDefinition` wire envelope deliberately delegates detailed DSL semantics to the normative Model Definition specification and validator.\n\n";
  text = text.slice(0, historyIndex) + note + text.slice(historyIndex);
  await write(path, text);
}

console.log("One-shot Time Semantics #217 contract migration applied.");

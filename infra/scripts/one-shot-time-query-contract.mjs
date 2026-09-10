import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const write = (path, content) => writeFile(resolve(root, path), content, "utf8");

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

async function replaceFile(path, before, after, label = path) {
  await write(path, replaceOnce(await read(path), before, after, label));
}

// Shared progressive semantic projection.
{
  const path = "apps/core/src/model-semantic-projection.ts";
  let text = await read(path);
  text = replaceOnce(
    text,
    'import { relationSemanticMetadata, type RelationResolutionDescriptor } from "./relation-semantic";\n',
    'import { relationSemanticMetadata, type RelationResolutionDescriptor } from "./relation-semantic";\nimport { genericComparisonFieldSemantics, type GenericComparisonFieldSemantic } from "./query-semantics";\n',
    "semantic query import",
  );
  text = replaceOnce(
    text,
    "  filters: ModelSemanticFilter[];\n  sort: {",
    "  filters: ModelSemanticFilter[];\n  comparisons: GenericComparisonFieldSemantic[];\n  sort: {",
    "semantic query comparison type",
  );
  text = replaceOnce(
    text,
    "    filters,\n    sort: {",
    "    filters,\n    comparisons: genericComparisonFieldSemantics(model.definition),\n    sort: {",
    "semantic query comparison projection",
  );
  await write(path, text);
}

// Generated immutable Model Contract uses the same semantic compiler.
{
  const path = "apps/core/src/model-contract.ts";
  let text = await read(path);
  text = replaceOnce(
    text,
    'import { referenceLabelSemantic } from "./reference-label";\n',
    'import { referenceLabelSemantic } from "./reference-label";\nimport { genericComparisonFieldSemantics } from "./query-semantics";\n',
    "model contract query import",
  );
  const insertion = `
  for (const semantic of genericComparisonFieldSemantics(model.definition)) {
    const valueSchema: JsonSchema = semantic.source === "model"
      ? fieldSchema({ ...model.definition.fields[semantic.field]!, nullable: false, readOnly: false })
      : { type: "string", format: "date-time" };
    for (const transport of semantic.operators) {
      const metadata = {
        "x-lifespace-query-field": semantic.field,
        "x-lifespace-query-source": semantic.source,
        "x-lifespace-operator": transport.operator,
        "x-lifespace-transport": transport.transport,
      };
      const existing = parameters.get(transport.parameter);
      if (existing) parameters.set(transport.parameter, { ...existing, ...metadata });
      else put({ name: transport.parameter, in: "query", schema: structuredClone(valueSchema), ...metadata });
    }
    if (semantic.localDateWindow) {
      const windowMetadata = {
        "x-lifespace-query-field": semantic.field,
        "x-lifespace-query-source": semantic.source,
        "x-lifespace-window-bounds": semantic.localDateWindow.bounds,
        "x-lifespace-window-lower-operator": semantic.localDateWindow.lowerOperator,
        "x-lifespace-window-upper-operator": semantic.localDateWindow.upperOperator,
      };
      put({
        name: semantic.localDateWindow.dateStartParameter,
        in: "query",
        schema: { type: "string", format: "date" },
        ...windowMetadata,
        "x-lifespace-local-date-window-role": "date-start",
      });
      put({
        name: semantic.localDateWindow.dateEndExclusiveParameter,
        in: "query",
        schema: { type: "string", format: "date" },
        ...windowMetadata,
        "x-lifespace-local-date-window-role": "date-end-exclusive",
      });
      put({
        name: semantic.localDateWindow.timezoneParameter,
        in: "query",
        schema: { type: "string", "x-lifespace-format": "iana-timezone" },
        ...windowMetadata,
        "x-lifespace-local-date-window-role": "viewing-timezone",
      });
    }
  }

`;
  text = replaceOnce(
    text,
    "  const genericSortValues = new Set([\n",
    insertion + "  const genericSortValues = new Set([\n",
    "model contract comparison parameters",
  );
  await write(path, text);
}

// Progressive semantic detail integration evidence.
{
  const path = "apps/core/test/runtime-model-semantic-detail.integration.test.ts";
  let text = await read(path);
  const anchor = `    expect(data.query.filters).toEqual(expect.arrayContaining([
      { field: "status", parameter: "status", mode: "enum-set" },
      { field: "rank", parameter: "rank", mode: "exact", range: { fromParameter: "rankFrom", toParameter: "rankTo" } },
      { field: "ownerPersonId", parameter: "ownerPersonId", mode: "exact" },
    ]));
`;
  const addition = anchor + `    expect(data.query.comparisons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "rank",
        source: "model",
        valueType: "integer",
        operators: expect.arrayContaining([
          { operator: "gte", parameter: "rankFrom", transport: "legacy" },
          { operator: "lt", parameter: "rank.lt", transport: "explicit" },
        ]),
      }),
      expect.objectContaining({
        field: "createdAt",
        source: "envelope",
        valueType: "datetime",
        localDateWindow: {
          dateStartParameter: "createdAt.dateStart",
          dateEndExclusiveParameter: "createdAt.dateEndExclusive",
          timezoneParameter: "createdAt.timezone",
          bounds: "[)",
          lowerOperator: "gte",
          upperOperator: "lt",
        },
      }),
      expect.objectContaining({ field: "updatedAt", source: "envelope", valueType: "datetime" }),
    ]));
`;
  text = replaceOnce(text, anchor, addition, "semantic detail comparison assertion");
  await write(path, text);
}

// Normative query semantics: semantic operators are independent from REST names.
{
  const path = "docs/model-definition-spec.md";
  let text = await read(path);
  const before = "For filterable `date`, `datetime`, `integer` and `number` fields, the generated query surface also supports `FieldFrom` / `FieldTo` style range parameters. A `timeRanges` declaration remains independent structural metadata and does not imply any additional overlap/interval query syntax.\n\nCapabilities may add their own semantic query parameters.";
  const after = `For filterable \`date\`, \`datetime\`, \`integer\` and \`number\` fields, Generic Query owns an explicit comparison-operator semantic set:\n\n\`\`\`text\neq | lt | lte | gt | gte\n\`\`\`\n\nThe semantic operator is independent from a REST parameter name. Existing v1 REST compatibility is frozen as:\n\n\`\`\`text\nfield=x       -> eq x\nfieldFrom=x   -> gte x\nfieldTo=x     -> lte x\n\`\`\`\n\nIn particular \`fieldTo\` remains inclusive. New explicit comparison transport uses collision-free \`field.operator\` parameter names such as \`dueDate.gte\` and \`dueDate.lt\`; Model field keys cannot contain \`.\`, so adapters never need to infer an operator from a field-name suffix. Supplying two transport aliases for the same field/operator in one request is invalid rather than silently choosing precedence.\n\nThe platform-owned envelope \`createdAt\` and \`updatedAt\` fields are always queryable \`datetime\` comparison fields even though they are not repeated in Model \`query.filterable\`. Their comparison transport is explicit only. Generated Model Contract metadata and Progressive Runtime Semantic Detail enumerate the actual operator/parameter mapping; adapters must consume that published mapping rather than reconstructing names.\n\nFor any comparison-queryable \`datetime\` field, Generic Query additionally exposes one concrete local-calendar window transport:\n\n\`\`\`text\n<field>.dateStart=YYYY-MM-DD\n<field>.dateEndExclusive=YYYY-MM-DD\n<field>.timezone=<IANA timezone>\n\`\`\`\n\nAll three parameters are required together. Core resolves the two local date boundaries with the shared DST-safe Time Semantics primitive and applies the canonical half-open instant predicate \`value >= startInclusive AND value < endExclusive\`. Adapters must not calculate UTC boundaries themselves. \`date\` fields remain calendar-date values and use ordinary explicit comparisons without timezone conversion.\n\nA \`timeRanges\` declaration remains independent structural metadata and does not imply any additional overlap/interval query syntax.\n\nConformance-ID: MDV1-QUERY-COMPARISON-01\nConformance-ID: MDV1-QUERY-LOCAL-DATE-WINDOW-01\n\nCapabilities may add their own semantic query parameters.`;
  text = replaceOnce(text, before, after, "normative generic time query semantics");
  await write(path, text);
}

// Fix the #217 cache-identity wording that remained stale in architecture.md.
{
  const path = "docs/architecture.md";
  let text = await read(path);
  text = replaceOnce(
    text,
    "while a successful semantic body is authority-independent and cacheable by `(key, version, schemaHash)`;",
    "while a successful semantic body is authority-independent and cacheable within one Kernel representation by `(key, version, schemaHash)`; a cache that survives Kernel deployment additionally keys by Kernel `contractVersion`;",
    "architecture semantic cache identity",
  );
  text = replaceOnce(text, "current Kernel contract: 0.33.0", "current Kernel contract: 0.34.0", "architecture Kernel version");
  await write(path, text);
}

// Kernel 0.34.0 static semantic representation.
{
  const path = "apps/core/openapi.yaml";
  const document = JSON.parse(await read(path));
  if (document.info?.version !== "0.33.0") throw new Error(`Expected Kernel 0.33.0, found ${document.info?.version}`);
  document.info.version = "0.34.0";
  document.info.description = document.info.description.replace(
    "canonical structural time-range semantics plus Person/ordinary-record Reference Projection",
    "canonical structural time-range and explicit Generic Query comparison semantics plus Person/ordinary-record Reference Projection",
  );
  document.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.34.0";
  const schemas = document.components.schemas;

  schemas.RuntimeModelSemanticComparisonOperator = {
    type: "object",
    additionalProperties: false,
    required: ["operator", "parameter", "transport"],
    properties: {
      operator: { type: "string", enum: ["eq", "lt", "lte", "gt", "gte"] },
      parameter: { type: "string", minLength: 1 },
      transport: { type: "string", enum: ["legacy", "explicit"] },
    },
  };
  schemas.RuntimeModelSemanticLocalDateWindow = {
    type: "object",
    additionalProperties: false,
    required: ["dateStartParameter", "dateEndExclusiveParameter", "timezoneParameter", "bounds", "lowerOperator", "upperOperator"],
    properties: {
      dateStartParameter: { type: "string", minLength: 1 },
      dateEndExclusiveParameter: { type: "string", minLength: 1 },
      timezoneParameter: { type: "string", minLength: 1 },
      bounds: { const: "[)" },
      lowerOperator: { const: "gte" },
      upperOperator: { const: "lt" },
    },
  };
  schemas.RuntimeModelSemanticComparison = {
    type: "object",
    additionalProperties: false,
    required: ["field", "source", "valueType", "operators"],
    properties: {
      field: { type: "string", minLength: 1 },
      source: { type: "string", enum: ["model", "envelope"] },
      valueType: { type: "string", enum: ["date", "datetime", "integer", "number"] },
      operators: { type: "array", minItems: 5, items: { $ref: "#/components/schemas/RuntimeModelSemanticComparisonOperator" } },
      localDateWindow: { $ref: "#/components/schemas/RuntimeModelSemanticLocalDateWindow" },
    },
  };

  const query = schemas.RuntimeModelSemanticQuery;
  if (query.required.includes("comparisons") || query.properties.comparisons) throw new Error("Runtime semantic comparisons already exist");
  const filterIndex = query.required.indexOf("filters");
  query.required.splice(filterIndex + 1, 0, "comparisons");
  const properties = {};
  for (const [key, value] of Object.entries(query.properties)) {
    properties[key] = value;
    if (key === "filters") {
      properties.comparisons = { type: "array", items: { $ref: "#/components/schemas/RuntimeModelSemanticComparison" } };
    }
  }
  query.properties = properties;

  const route = document.paths["/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"].get;
  route.description += " Query comparisons enumerate explicit semantic operators, their concrete transport parameters, platform envelope fields, and DST-safe local-date-window transport so generic adapters do not infer suffix semantics or compute UTC boundaries.";
  await write(path, JSON.stringify(document));
}

// Kernel checker and runtime/package versions.
{
  const path = "apps/core/scripts/check-openapi.mjs";
  let text = await read(path);
  const versionMatches = text.match(/0\.33\.0/g) ?? [];
  if (versionMatches.length !== 2) throw new Error(`Expected exactly two 0.33.0 checker references, found ${versionMatches.length}`);
  text = text.replaceAll("0.33.0", "0.34.0");
  const oldCheck = `if (!schemas.RuntimeModelSemanticQuery?.required?.includes("filters")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("pagination")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("capabilityParameters")
    || schemas.RuntimeModelSemanticQuery?.properties?.sort?.properties?.nullPlacement?.const !== "last") {
  throw new Error("Single-model semantic detail must expose complete shared query facts");
}`;
  const newCheck = `if (!schemas.RuntimeModelSemanticQuery?.required?.includes("filters")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("comparisons")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("pagination")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("capabilityParameters")
    || schemas.RuntimeModelSemanticQuery?.properties?.comparisons?.items?.$ref !== "#/components/schemas/RuntimeModelSemanticComparison"
    || schemas.RuntimeModelSemanticComparison?.additionalProperties !== false
    || JSON.stringify(schemas.RuntimeModelSemanticComparison?.properties?.source?.enum) !== JSON.stringify(["model", "envelope"])
    || JSON.stringify(schemas.RuntimeModelSemanticComparison?.properties?.valueType?.enum) !== JSON.stringify(["date", "datetime", "integer", "number"])
    || JSON.stringify(schemas.RuntimeModelSemanticComparisonOperator?.properties?.operator?.enum) !== JSON.stringify(["eq", "lt", "lte", "gt", "gte"])
    || JSON.stringify(schemas.RuntimeModelSemanticComparisonOperator?.properties?.transport?.enum) !== JSON.stringify(["legacy", "explicit"])
    || schemas.RuntimeModelSemanticLocalDateWindow?.properties?.bounds?.const !== "[)"
    || schemas.RuntimeModelSemanticLocalDateWindow?.properties?.lowerOperator?.const !== "gte"
    || schemas.RuntimeModelSemanticLocalDateWindow?.properties?.upperOperator?.const !== "lt"
    || schemas.RuntimeModelSemanticQuery?.properties?.sort?.properties?.nullPlacement?.const !== "last") {
  throw new Error("Single-model semantic detail must expose complete shared query facts");
}`;
  text = replaceOnce(text, oldCheck, newCheck, "Kernel query semantic checker");
  await write(path, text);
}

await replaceFile("apps/core/src/app.ts", 'contractVersion: "0.33.0"', 'contractVersion: "0.34.0"', "Core status version");
{
  const path = "apps/core/package.json";
  const pkg = JSON.parse(await read(path));
  if (pkg.version !== "0.33.0") throw new Error(`Expected @lifespace/core 0.33.0, found ${pkg.version}`);
  pkg.version = "0.34.0";
  await write(path, JSON.stringify(pkg, null, 2) + "\n");
}
await replaceFile("apps/core/AGENTS.md", "current Kernel version: 0.33.0", "current Kernel version: 0.34.0", "Core AGENTS version");
await replaceFile(
  "apps/core/README.md",
  "The current business-facing Core Kernel contract is **0.33.0**. Progressive single-model semantic detail now includes canonical structural `timeRanges` projected from Model Definition declarations and registered Capability bindings; this metadata does not itself imply an interval query operator.",
  "The current business-facing Core Kernel contract is **0.34.0**. Progressive single-model semantic detail includes canonical structural `timeRanges` plus explicit Generic Query comparison/operator transport, platform envelope time fields, and DST-safe local-date-window semantics. Structural ranges still do not imply an interval-overlap operator.",
  "Core README version",
);
await replaceFile("README.md", "The current repository Core Kernel contract is **0.33.0**.", "The current repository Core Kernel contract is **0.34.0**.", "root README version");

{
  const path = "docs/contracts.md";
  let text = await read(path);
  text = replaceOnce(
    text,
    "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.33.0` owns neither Model Registry governance nor Eventing wire representation.",
    "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.34.0` owns neither Model Registry governance nor Eventing wire representation.",
    "contracts current Kernel version",
  );
  const historyAnchor = "Core Kernel `0.33.0` adds canonical structural `timeRanges`";
  const index = text.indexOf(historyAnchor);
  if (index < 0) throw new Error("Missing Kernel 0.33 history anchor");
  const note = "Core Kernel `0.34.0` adds explicit Generic Query comparison semantics to progressive static detail and generated Model Contracts. Legacy `field` / `fieldFrom` / `fieldTo` remain eq/gte/lte with inclusive `fieldTo`; new collision-free `field.operator` transport provides eq/lt/lte/gt/gte, platform envelope `createdAt` / `updatedAt` become first-class datetime comparison fields, and datetime local-date windows delegate DST-safe boundary conversion to the shared Time Semantics primitive. Schema migration 0038 adds the Space+Model-scoped updatedAt index required by the new envelope query shape.\n\n";
  text = text.slice(0, index) + note + text.slice(index);
  await write(path, text);
}

console.log("Generic Time Query contract migration applied.");

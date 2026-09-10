import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const write = (path, value) => fs.writeFileSync(path, value);

function replaceOnce(text, oldText, newText, path) {
  const first = text.indexOf(oldText);
  if (first < 0) throw new Error(`${path}: replacement anchor not found: ${oldText.slice(0, 120)}`);
  const second = text.indexOf(oldText, first + oldText.length);
  if (second >= 0) throw new Error(`${path}: replacement anchor is not unique: ${oldText.slice(0, 120)}`);
  return `${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}`;
}

function updateText(path, transform) {
  const before = read(path);
  const after = transform(before);
  if (after === before) throw new Error(`${path}: transform made no change`);
  write(path, after);
}

// Runtime must consume the same Calendar semantic descriptor published to Discovery / Model Contract.
updateText("apps/core/src/calendar-query.ts", (text) => {
  text = replaceOnce(
    text,
    'import type { Bindings, Principal } from "./env";\n',
    'import {\n  CALENDAR_LEGACY_WINDOW_PARAMETERS,\n  CALENDAR_VIEWING_WINDOW_ORDERING,\n  CALENDAR_VIEWING_WINDOW_PARAMETERS,\n} from "./calendar-query-semantics";\nimport type { Bindings, Principal } from "./env";\n',
    "apps/core/src/calendar-query.ts",
  );
  text = replaceOnce(
    text,
    'const CALENDAR_SORTS = new Set(["calendarStart:asc", "calendarStart:desc"]);\nconst LEGACY_WINDOW_PARAMETERS = ["rangeStart", "rangeEnd", "dateStart", "dateEndExclusive"] as const;\nconst VIEWING_WINDOW_PARAMETERS = ["windowStartDate", "windowEndDateExclusive", "viewingTimezone"] as const;\n',
    'const CALENDAR_SORTS = new Set<string>(CALENDAR_VIEWING_WINDOW_ORDERING.values);\nconst VIEWING_WINDOW_PARAMETER_NAMES = CALENDAR_VIEWING_WINDOW_PARAMETERS.map(({ parameter }) => parameter);\n',
    "apps/core/src/calendar-query.ts",
  );
  text = text.replaceAll("LEGACY_WINDOW_PARAMETERS", "CALENDAR_LEGACY_WINDOW_PARAMETERS");
  text = text.replaceAll("VIEWING_WINDOW_PARAMETERS", "VIEWING_WINDOW_PARAMETER_NAMES");
  text = replaceOnce(
    text,
    '  const sort = sorts[0] ?? "calendarStart:asc";\n',
    '  const sort = sorts[0] ?? CALENDAR_VIEWING_WINDOW_ORDERING.default;\n',
    "apps/core/src/calendar-query.ts",
  );
  return text;
});

// Progressive semantic detail: keep legacy flat capabilityParameters and add preferred grouped capabilityQueries.
updateText("apps/core/src/model-semantic-projection.ts", (text) => {
  text = replaceOnce(
    text,
    'import type { CalendarCapabilityDefinition, TemporalCapabilityDefinition } from "./capability-definition";\n',
    'import type { CalendarCapabilityDefinition, TemporalCapabilityDefinition } from "./capability-definition";\nimport { calendarViewingWindowSemanticQuery } from "./calendar-query-semantics";\n',
    "apps/core/src/model-semantic-projection.ts",
  );
  text = replaceOnce(
    text,
    'export type ModelSemanticQueryFacts = {\n',
    'export type ModelSemanticCapabilityQuery = ReturnType<typeof calendarViewingWindowSemanticQuery>;\n\nexport type ModelSemanticQueryFacts = {\n',
    "apps/core/src/model-semantic-projection.ts",
  );
  text = replaceOnce(
    text,
    '  capabilityParameters: ModelSemanticQueryParameter[];\n};\n',
    '  capabilityParameters: ModelSemanticQueryParameter[];\n  capabilityQueries: ModelSemanticCapabilityQuery[];\n};\n',
    "apps/core/src/model-semantic-projection.ts",
  );
  text = replaceOnce(
    text,
    '  const capabilityParameters: ModelSemanticQueryParameter[] = [];\n',
    '  const capabilityParameters: ModelSemanticQueryParameter[] = [];\n  const capabilityQueries: ModelSemanticCapabilityQuery[] = [];\n',
    "apps/core/src/model-semantic-projection.ts",
  );
  text = replaceOnce(
    text,
    '  if (model.definition.capabilities?.calendar) {\n    capabilityParameters.push(\n      { parameter: "rangeStart", type: "datetime", pairedWith: "rangeEnd" },\n      { parameter: "rangeEnd", type: "datetime", pairedWith: "rangeStart" },\n      { parameter: "dateStart", type: "date", pairedWith: "dateEndExclusive" },\n      { parameter: "dateEndExclusive", type: "date", pairedWith: "dateStart" },\n    );\n    semanticValues.push("calendarStart:asc", "calendarStart:desc");\n    semanticDefaults.calendar = "calendarStart:asc";\n  }\n',
    '  if (model.definition.capabilities?.calendar) {\n    capabilityParameters.push(\n      { parameter: "rangeStart", type: "datetime", pairedWith: "rangeEnd" },\n      { parameter: "rangeEnd", type: "datetime", pairedWith: "rangeStart" },\n      { parameter: "dateStart", type: "date", pairedWith: "dateEndExclusive" },\n      { parameter: "dateEndExclusive", type: "date", pairedWith: "dateStart" },\n    );\n    const calendarQuery = calendarViewingWindowSemanticQuery();\n    capabilityQueries.push(calendarQuery);\n    semanticValues.push(...calendarQuery.ordering.values);\n    semanticDefaults.calendar = calendarQuery.ordering.default;\n  }\n',
    "apps/core/src/model-semantic-projection.ts",
  );
  text = replaceOnce(
    text,
    '    capabilityParameters,\n  };\n',
    '    capabilityParameters,\n    capabilityQueries,\n  };\n',
    "apps/core/src/model-semantic-projection.ts",
  );
  return text;
});

// Generated Model Contract consumes the same descriptor and marks preferred vs compatibility transport explicitly.
updateText("apps/core/src/model-contract.ts", (text) => {
  text = replaceOnce(
    text,
    'import type { FieldDefinition, ModelDefinition } from "./model-definition";\n',
    'import { calendarViewingWindowSemanticQuery } from "./calendar-query-semantics";\nimport type { FieldDefinition, ModelDefinition } from "./model-definition";\n',
    "apps/core/src/model-contract.ts",
  );
  text = replaceOnce(
    text,
    '  const temporal = model.definition.capabilities?.temporal;\n  const calendar = model.definition.capabilities?.calendar;\n',
    '  const temporal = model.definition.capabilities?.temporal;\n  const calendar = model.definition.capabilities?.calendar;\n  const calendarQuery = calendar ? calendarViewingWindowSemanticQuery() : null;\n',
    "apps/core/src/model-contract.ts",
  );
  text = replaceOnce(
    text,
    '  if (calendar) {\n    put({ name: "rangeStart", in: "query", schema: { type: "string", format: "date-time" }, "x-lifespace-paired-with": "rangeEnd" });\n    put({ name: "rangeEnd", in: "query", schema: { type: "string", format: "date-time" }, "x-lifespace-paired-with": "rangeStart" });\n    put({ name: "dateStart", in: "query", schema: { type: "string", format: "date" }, "x-lifespace-paired-with": "dateEndExclusive" });\n    put({ name: "dateEndExclusive", in: "query", schema: { type: "string", format: "date" }, "x-lifespace-paired-with": "dateStart" });\n    semanticSortValues.add("calendarStart:asc");\n    semanticSortValues.add("calendarStart:desc");\n  }\n',
    '  if (calendarQuery) {\n    put({ name: "rangeStart", in: "query", schema: { type: "string", format: "date-time" }, "x-lifespace-paired-with": "rangeEnd", "x-lifespace-compatibility-for": calendarQuery.key });\n    put({ name: "rangeEnd", in: "query", schema: { type: "string", format: "date-time" }, "x-lifespace-paired-with": "rangeStart", "x-lifespace-compatibility-for": calendarQuery.key });\n    put({ name: "dateStart", in: "query", schema: { type: "string", format: "date" }, "x-lifespace-paired-with": "dateEndExclusive", "x-lifespace-compatibility-for": calendarQuery.key });\n    put({ name: "dateEndExclusive", in: "query", schema: { type: "string", format: "date" }, "x-lifespace-paired-with": "dateStart", "x-lifespace-compatibility-for": calendarQuery.key });\n    for (const parameter of calendarQuery.parameters) {\n      put({\n        name: parameter.parameter,\n        in: "query",\n        schema: parameter.type === "timezone"\n          ? { type: "string", "x-lifespace-format": "iana-timezone" }\n          : { type: "string", format: "date" },\n        "x-lifespace-capability-query": calendarQuery.key,\n        "x-lifespace-query-semantics": calendarQuery.semantics,\n        "x-lifespace-query-role": parameter.role,\n        "x-lifespace-required-with": calendarQuery.parameters\n          .filter((candidate) => candidate.parameter !== parameter.parameter)\n          .map((candidate) => candidate.parameter),\n        "x-lifespace-recurrence-expansion": calendarQuery.recurrenceExpansion,\n      });\n    }\n    for (const value of calendarQuery.ordering.values) semanticSortValues.add(value);\n  }\n',
    "apps/core/src/model-contract.ts",
  );
  text = replaceOnce(
    text,
    '            ...(calendar ? { calendar: "calendarStart:asc" } : {}),\n',
    '            ...(calendarQuery ? { calendar: calendarQuery.ordering.default } : {}),\n',
    "apps/core/src/model-contract.ts",
  );
  text = replaceOnce(
    text,
    '        }\n      : genericSortSchema,\n  });\n',
    '        }\n      : genericSortSchema,\n    ...(calendarQuery ? { "x-lifespace-capability-query-ordering": structuredClone(calendarQuery.ordering) } : {}),\n  });\n',
    "apps/core/src/model-contract.ts",
  );
  return text;
});

// Compiler-level projection tests.
updateText("apps/core/test/model-semantic-time-ranges.test.ts", (text) => {
  text = replaceOnce(
    text,
    '    expect(semantic.query.capabilityParameters).toEqual([]);\n    expect(semantic.query.filters).toEqual([]);\n',
    '    expect(semantic.query.capabilityParameters).toEqual([]);\n    expect(semantic.query.capabilityQueries).toEqual([]);\n    expect(semantic.query.filters).toEqual([]);\n',
    "apps/core/test/model-semantic-time-ranges.test.ts",
  );
  text = replaceOnce(
    text,
    '    expect(semantic.timeRanges).toEqual([\n      {\n        key: "calendar.allDay",\n        startField: "startDate",\n        endField: "endDateExclusive",\n        valueType: "date",\n        bounds: "[)",\n        source: "capability",\n        capability: "calendar",\n      },\n      {\n        key: "calendar.timed",\n        startField: "startAt",\n        endField: "endAt",\n        valueType: "datetime",\n        bounds: "[)",\n        source: "capability",\n        capability: "calendar",\n      },\n    ]);\n',
    '    expect(semantic.timeRanges).toEqual([\n      {\n        key: "calendar.allDay",\n        startField: "startDate",\n        endField: "endDateExclusive",\n        valueType: "date",\n        bounds: "[)",\n        source: "capability",\n        capability: "calendar",\n      },\n      {\n        key: "calendar.timed",\n        startField: "startAt",\n        endField: "endAt",\n        valueType: "datetime",\n        bounds: "[)",\n        source: "capability",\n        capability: "calendar",\n      },\n    ]);\n    expect(semantic.query.capabilityQueries).toEqual([{\n      key: "calendar.window",\n      capability: "calendar",\n      semantics: "record-interval-overlap",\n      recurrenceExpansion: false,\n      parameters: [\n        { parameter: "windowStartDate", type: "date", required: true, role: "window-start-date" },\n        { parameter: "windowEndDateExclusive", type: "date", required: true, role: "window-end-date-exclusive" },\n        { parameter: "viewingTimezone", type: "timezone", required: true, role: "viewing-timezone" },\n      ],\n      ordering: {\n        parameter: "sort",\n        values: ["calendarStart:asc", "calendarStart:desc"],\n        default: "calendarStart:asc",\n        dateBasis: "viewing-timezone",\n        allDayPlacement: "before-timed-within-date",\n        timedOrder: "instant",\n        tieBreaker: "record-id-asc",\n      },\n    }]);\n    expect(semantic.query.capabilityParameters).toEqual([\n      { parameter: "rangeStart", type: "datetime", pairedWith: "rangeEnd" },\n      { parameter: "rangeEnd", type: "datetime", pairedWith: "rangeStart" },\n      { parameter: "dateStart", type: "date", pairedWith: "dateEndExclusive" },\n      { parameter: "dateEndExclusive", type: "date", pairedWith: "dateStart" },\n    ]);\n',
    "apps/core/test/model-semantic-time-ranges.test.ts",
  );
  return text;
});

// Calendar conformance oracle covers both old transport and preferred grouped window semantics.
updateText("apps/core/test/model-definition-oracles.test.ts", (text) => {
  text = replaceOnce(
    text,
    '  // Covers: MDV1-CAPABILITY-CALENDAR-01\n  it("checks Calendar timed/all-day bindings and semantic query inputs", async () => {\n',
    '  // Covers: MDV1-CAPABILITY-CALENDAR-01, MDV1-CAPABILITY-CALENDAR-WINDOW-01\n  it("checks Calendar timed/all-day bindings and semantic query inputs", async () => {\n',
    "apps/core/test/model-definition-oracles.test.ts",
  );
  text = replaceOnce(
    text,
    '    const names = collection.get.parameters.map((parameter: any) => parameter.name);\n    expect(names).toEqual(expect.arrayContaining(["rangeStart", "rangeEnd", "dateStart", "dateEndExclusive", "sort"]));\n    const create = schema(contract, "OracleCalendarCreate") as any;\n',
    '    const parameters = collection.get.parameters as any[];\n    const names = parameters.map((parameter: any) => parameter.name);\n    expect(names).toEqual(expect.arrayContaining([\n      "rangeStart", "rangeEnd", "dateStart", "dateEndExclusive",\n      "windowStartDate", "windowEndDateExclusive", "viewingTimezone", "sort",\n    ]));\n    const byName = (name: string) => parameters.find((parameter: any) => parameter.name === name);\n    expect(byName("windowStartDate")).toMatchObject({\n      "x-lifespace-capability-query": "calendar.window",\n      "x-lifespace-query-semantics": "record-interval-overlap",\n      "x-lifespace-query-role": "window-start-date",\n      "x-lifespace-recurrence-expansion": false,\n    });\n    expect(byName("viewingTimezone")?.schema?.["x-lifespace-format"]).toBe("iana-timezone");\n    expect(byName("rangeStart")?.["x-lifespace-compatibility-for"]).toBe("calendar.window");\n    expect(byName("sort")?.["x-lifespace-capability-query-ordering"]).toMatchObject({\n      dateBasis: "viewing-timezone",\n      allDayPlacement: "before-timed-within-date",\n      timedOrder: "instant",\n    });\n    const create = schema(contract, "OracleCalendarCreate") as any;\n',
    "apps/core/test/model-definition-oracles.test.ts",
  );
  return text;
});

// Keep one old Calendar performance path and make the other prove the new grouped viewing-window path.
updateText("apps/core/test/performance-budget.integration.test.ts", (text) => replaceOnce(
  text,
  '      () => f.request(`/api/v1/spaces/${f.spaceId}/models/event/records?rangeStart=2026-07-31T00%3A00%3A00.000Z&rangeEnd=2026-08-02T00%3A00%3A00.000Z&dateStart=2026-07-31&dateEndExclusive=2026-08-02&sort=calendarStart%3Aasc&limit=100`),\n',
  '      () => f.request(`/api/v1/spaces/${f.spaceId}/models/event/records?windowStartDate=2026-08-01&windowEndDateExclusive=2026-08-02&viewingTimezone=UTC&sort=calendarStart%3Aasc&limit=100`),\n',
  "apps/core/test/performance-budget.integration.test.ts",
));

// Normative Calendar capability semantics.
updateText("docs/model-definition-spec.md", (text) => replaceOnce(
  text,
  'Runtime Discovery may project these canonical Calendar field roles through a bounded Capability binding so generic clients can distinguish timed from all-day inputs without inferring field names. That projection is derived from this Model Definition mapping, contains no UI layout semantics and does not replace execution-time Calendar validation.\n\nConformance-ID: MDV1-CAPABILITY-CALENDAR-01\n',
  'Runtime Discovery may project these canonical Calendar field roles through a bounded Capability binding so generic clients can distinguish timed from all-day inputs without inferring field names. That projection is derived from this Model Definition mapping, contains no UI layout semantics and does not replace execution-time Calendar validation.\n\nConformance-ID: MDV1-CAPABILITY-CALENDAR-01\n\nCalendar also owns one preferred high-level viewing-window query whose caller supplies concrete local calendar dates plus an explicit viewing timezone:\n\n```text\nwindowStartDate=YYYY-MM-DD\nwindowEndDateExclusive=YYYY-MM-DD\nviewingTimezone=<IANA timezone>\n```\n\nAll three parameters are required together. Relative-language inputs such as `today` or `tomorrow` are not Calendar Runtime syntax; a caller/Agent resolves them to concrete dates before execution. Core converts the local date boundaries with the shared Time Semantics primitive and applies separate half-open overlap predicates to the two Calendar representations:\n\n```text\ntimed:   startAt < instantWindowEnd AND endAt > instantWindowStart\nall-day: startDate < windowEndDateExclusive AND endDateExclusive > windowStartDate\n```\n\nTimed records are therefore compared as absolute instants while all-day records remain calendar-date facts. Adapters must not independently compute UTC/DST boundaries. The existing `rangeStart` / `rangeEnd` and `dateStart` / `dateEndExclusive` parameters remain compatibility transport; they are not mixed with the preferred viewing-window transport in one request.\n\nFor the preferred query, `calendarStart` ordering is defined in the explicit viewing timezone: compare viewing calendar date first, place all-day records before timed records within the same date, order timed records by absolute start instant, then use stable record ID as the final tie-breaker. Recurrence expansion is not implied or performed by this query. Progressive Runtime Semantic Detail and generated Model Contracts publish this grouped semantic query so MCP, n8n and generated clients consume the platform definition instead of inferring special Event field names or timezone math.\n\nConformance-ID: MDV1-CAPABILITY-CALENDAR-WINDOW-01\n',
  "docs/model-definition-spec.md",
));

// Kernel representation moves to 0.35.0 because progressive semantic detail gains capabilityQueries.
updateText("apps/core/src/app.ts", (text) => replaceOnce(
  text,
  'schemaVersion: await schemaVersion(context.env), contractVersion: "0.34.0",',
  'schemaVersion: await schemaVersion(context.env), contractVersion: "0.35.0",',
  "apps/core/src/app.ts",
));

const corePackagePath = "apps/core/package.json";
const corePackage = JSON.parse(read(corePackagePath));
if (corePackage.version !== "0.34.0") throw new Error(`${corePackagePath}: expected version 0.34.0`);
corePackage.version = "0.35.0";
write(corePackagePath, `${JSON.stringify(corePackage, null, 2)}\n`);

updateText("README.md", (text) => replaceOnce(
  text,
  'The current repository Core Kernel contract is **0.34.0**.',
  'The current repository Core Kernel contract is **0.35.0**.',
  "README.md",
));
updateText("apps/core/README.md", (text) => {
  text = replaceOnce(
    text,
    'The current business-facing Core Kernel contract is **0.34.0**.',
    'The current business-facing Core Kernel contract is **0.35.0**.',
    "apps/core/README.md",
  );
  text = replaceOnce(
    text,
    'Progressive single-model semantic detail includes canonical structural `timeRanges` plus explicit Generic Query comparison/operator transport, platform envelope time fields, and DST-safe local-date-window semantics.',
    'Progressive single-model semantic detail includes canonical structural `timeRanges`, explicit Generic Query comparison/operator transport, platform envelope time fields, DST-safe local-date-window semantics, and the preferred grouped `calendar.window` viewing-window query while retaining the older flat Calendar range/date parameters as compatibility transport.',
    "apps/core/README.md",
  );
  return text;
});
updateText("apps/core/AGENTS.md", (text) => replaceOnce(
  text,
  'current Kernel version: 0.34.0',
  'current Kernel version: 0.35.0',
  "apps/core/AGENTS.md",
));
updateText("docs/architecture.md", (text) => replaceOnce(
  text,
  'current Kernel contract: 0.34.0',
  'current Kernel contract: 0.35.0',
  "docs/architecture.md",
));
updateText("docs/contracts.md", (text) => {
  text = replaceOnce(
    text,
    'The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.34.0` owns neither Model Registry governance nor Eventing wire representation.',
    'The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.35.0` owns neither Model Registry governance nor Eventing wire representation.',
    "docs/contracts.md",
  );
  text = replaceOnce(
    text,
    'Core Kernel `0.34.0` adds explicit Generic Query comparison semantics to progressive static detail and generated Model Contracts.',
    'Core Kernel `0.35.0` adds the preferred grouped `calendar.window` viewing-window semantic query to progressive static detail and generated Model Contracts. Callers provide concrete `windowStartDate` / `windowEndDateExclusive` plus explicit `viewingTimezone`; Core reuses the shared DST-safe Time Semantics conversion for timed overlap, keeps all-day overlap date-based, and defines mixed Calendar ordering in viewing-timezone semantics. The prior `rangeStart` / `rangeEnd` / `dateStart` / `dateEndExclusive` transport remains compatibility syntax and is not mixed with the preferred group. No recurrence/free-busy behavior is introduced.\n\nCore Kernel `0.34.0` adds explicit Generic Query comparison semantics to progressive static detail and generated Model Contracts.',
    "docs/contracts.md",
  );
  return text;
});

// Kernel OpenAPI is code-owned representation for progressive semantic detail.
const openapiPath = "apps/core/openapi.yaml";
const openapi = JSON.parse(read(openapiPath));
if (openapi.info?.version !== "0.34.0") throw new Error(`${openapiPath}: expected Kernel 0.34.0`);
openapi.info.version = "0.35.0";
openapi.info.description = openapi.info.description.replace(
  "canonical structural time-range and explicit Generic Query comparison semantics",
  "canonical structural time-range, explicit Generic Query comparison semantics, and grouped Calendar viewing-window semantics",
);
openapi.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.35.0";
const semanticDetailDescription = openapi.paths["/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"].get.description;
if (!semanticDetailDescription.includes("Query comparisons enumerate explicit semantic operators")) {
  throw new Error(`${openapiPath}: semantic detail description anchor missing`);
}
openapi.paths["/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"].get.description = `${semanticDetailDescription} Capability semantic queries additionally enumerate preferred grouped high-level operations such as Calendar calendar.window; legacy flat Capability parameters remain compatibility syntax.`;

const schemas = openapi.components.schemas;
schemas.RuntimeModelSemanticCalendarWindowParameter = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["parameter", "type", "required", "role"],
      properties: {
        parameter: { const: "windowStartDate" },
        type: { const: "date" },
        required: { const: true },
        role: { const: "window-start-date" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["parameter", "type", "required", "role"],
      properties: {
        parameter: { const: "windowEndDateExclusive" },
        type: { const: "date" },
        required: { const: true },
        role: { const: "window-end-date-exclusive" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["parameter", "type", "required", "role"],
      properties: {
        parameter: { const: "viewingTimezone" },
        type: { const: "timezone" },
        required: { const: true },
        role: { const: "viewing-timezone" },
      },
    },
  ],
};
schemas.RuntimeModelSemanticCalendarWindowOrdering = {
  type: "object",
  additionalProperties: false,
  required: ["parameter", "values", "default", "dateBasis", "allDayPlacement", "timedOrder", "tieBreaker"],
  properties: {
    parameter: { const: "sort" },
    values: { const: ["calendarStart:asc", "calendarStart:desc"] },
    default: { const: "calendarStart:asc" },
    dateBasis: { const: "viewing-timezone" },
    allDayPlacement: { const: "before-timed-within-date" },
    timedOrder: { const: "instant" },
    tieBreaker: { const: "record-id-asc" },
  },
};
schemas.RuntimeModelSemanticCalendarWindowQuery = {
  type: "object",
  additionalProperties: false,
  required: ["key", "capability", "semantics", "recurrenceExpansion", "parameters", "ordering"],
  properties: {
    key: { const: "calendar.window" },
    capability: { const: "calendar" },
    semantics: { const: "record-interval-overlap" },
    recurrenceExpansion: { const: false },
    parameters: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { $ref: "#/components/schemas/RuntimeModelSemanticCalendarWindowParameter" },
    },
    ordering: { $ref: "#/components/schemas/RuntimeModelSemanticCalendarWindowOrdering" },
  },
};
schemas.RuntimeModelSemanticCapabilityQuery = {
  oneOf: [{ $ref: "#/components/schemas/RuntimeModelSemanticCalendarWindowQuery" }],
};
const semanticQuery = schemas.RuntimeModelSemanticQuery;
if (!semanticQuery.required.includes("capabilityParameters")) throw new Error(`${openapiPath}: capabilityParameters baseline missing`);
if (!semanticQuery.required.includes("capabilityQueries")) semanticQuery.required.push("capabilityQueries");
semanticQuery.properties.capabilityQueries = {
  type: "array",
  items: { $ref: "#/components/schemas/RuntimeModelSemanticCapabilityQuery" },
};
write(openapiPath, `${JSON.stringify(openapi)}\n`);

// Contract sanity check must fail if the grouped Calendar representation drifts.
updateText("apps/core/scripts/check-openapi.mjs", (text) => {
  text = replaceOnce(text, 'document.info?.version !== "0.34.0"', 'document.info?.version !== "0.35.0"', "apps/core/scripts/check-openapi.mjs");
  text = replaceOnce(
    text,
    '    || !schemas.RuntimeModelSemanticQuery?.required?.includes("capabilityParameters")\n    || schemas.RuntimeModelSemanticQuery?.properties?.comparisons?.items?.$ref !== "#/components/schemas/RuntimeModelSemanticComparison"\n',
    '    || !schemas.RuntimeModelSemanticQuery?.required?.includes("capabilityParameters")\n    || !schemas.RuntimeModelSemanticQuery?.required?.includes("capabilityQueries")\n    || schemas.RuntimeModelSemanticQuery?.properties?.capabilityQueries?.items?.$ref !== "#/components/schemas/RuntimeModelSemanticCapabilityQuery"\n    || schemas.RuntimeModelSemanticQuery?.properties?.comparisons?.items?.$ref !== "#/components/schemas/RuntimeModelSemanticComparison"\n',
    "apps/core/scripts/check-openapi.mjs",
  );
  text = replaceOnce(
    text,
    'if (!schemas.RuntimeModelSemanticAction?.required?.includes("invocation")\n',
    'const calendarWindowQuery = schemas.RuntimeModelSemanticCalendarWindowQuery;\nconst calendarWindowOrdering = schemas.RuntimeModelSemanticCalendarWindowOrdering;\nconst calendarWindowParameters = schemas.RuntimeModelSemanticCalendarWindowParameter?.oneOf ?? [];\nif (schemas.RuntimeModelSemanticCapabilityQuery?.oneOf?.[0]?.$ref !== "#/components/schemas/RuntimeModelSemanticCalendarWindowQuery"\n    || calendarWindowQuery?.properties?.key?.const !== "calendar.window"\n    || calendarWindowQuery?.properties?.capability?.const !== "calendar"\n    || calendarWindowQuery?.properties?.semantics?.const !== "record-interval-overlap"\n    || calendarWindowQuery?.properties?.recurrenceExpansion?.const !== false\n    || calendarWindowQuery?.properties?.parameters?.minItems !== 3\n    || calendarWindowQuery?.properties?.parameters?.maxItems !== 3\n    || calendarWindowParameters.length !== 3\n    || JSON.stringify(calendarWindowParameters.map((entry) => entry?.properties?.parameter?.const)) !== JSON.stringify(["windowStartDate", "windowEndDateExclusive", "viewingTimezone"])\n    || JSON.stringify(calendarWindowParameters.map((entry) => entry?.properties?.type?.const)) !== JSON.stringify(["date", "date", "timezone"])\n    || calendarWindowOrdering?.properties?.dateBasis?.const !== "viewing-timezone"\n    || calendarWindowOrdering?.properties?.allDayPlacement?.const !== "before-timed-within-date"\n    || calendarWindowOrdering?.properties?.timedOrder?.const !== "instant"\n    || calendarWindowOrdering?.properties?.tieBreaker?.const !== "record-id-asc") {\n  throw new Error("Single-model semantic detail Calendar viewing-window query drifted");\n}\nif (!schemas.RuntimeModelSemanticAction?.required?.includes("invocation")\n',
    "apps/core/scripts/check-openapi.mjs",
  );
  return text;
});

console.log("Calendar M2 final transform completed");

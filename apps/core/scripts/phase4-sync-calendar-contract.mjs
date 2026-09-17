import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const kernelVersion = "0.36.0";
const fieldPattern = "^[a-z][A-Za-z0-9]{0,62}$";

function file(rel) {
  return path.join(repoRoot, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), "utf8");
}

function write(rel, value) {
  fs.writeFileSync(file(rel), value);
}

function replaceExact(rel, before, after, label = before) {
  const source = read(rel);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${rel}: missing expected text for ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`${rel}: expected text is not unique for ${label}`);
  write(rel, `${source.slice(0, first)}${after}${source.slice(first + before.length)}`);
}

function replaceRegex(rel, pattern, after, label) {
  const source = read(rel);
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`${rel}: expected one match for ${label}, found ${matches.length}`);
  write(rel, source.replace(pattern, after));
}

function fieldKeySchema() {
  return { type: "string", pattern: fieldPattern };
}

function canonicalCalendarBinding() {
  return {
    type: "object",
    description: "Current canonical Calendar binding. The named field is the authoritative temporal_range value used by Generic Runtime and Canonical Query.",
    additionalProperties: false,
    required: ["rangeField"],
    properties: {
      rangeField: fieldKeySchema(),
      attendeePersonField: fieldKeySchema(),
    },
  };
}

function legacyCalendarBinding() {
  return {
    type: "object",
    description: "Legacy split-field Calendar binding retained only so historical published Model Definitions remain interpretable during migration.",
    deprecated: true,
    additionalProperties: false,
    required: [
      "allDayField",
      "timedStartField",
      "timedEndField",
      "startTimezoneField",
      "endTimezoneField",
      "allDayStartField",
      "allDayEndExclusiveField",
    ],
    properties: {
      allDayField: fieldKeySchema(),
      timedStartField: fieldKeySchema(),
      timedEndField: fieldKeySchema(),
      startTimezoneField: fieldKeySchema(),
      endTimezoneField: fieldKeySchema(),
      allDayStartField: fieldKeySchema(),
      allDayEndExclusiveField: fieldKeySchema(),
      attendeePersonField: fieldKeySchema(),
    },
  };
}

const openapiPath = "apps/core/openapi.yaml";
const openapi = JSON.parse(read(openapiPath));
openapi.info.version = kernelVersion;
openapi.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = kernelVersion;
const calendarBindingUnion = {
  description: "Calendar Capability field-role binding. Current models use one temporal_range rangeField; the legacy split-field representation remains readable only for historical published definitions.",
  oneOf: [canonicalCalendarBinding(), legacyCalendarBinding()],
};
openapi.components.schemas.RuntimeDiscoveryCalendarCapabilityBinding = calendarBindingUnion;
openapi.components.schemas.RuntimeModelSemanticCalendarBinding = structuredClone(calendarBindingUnion);
write(openapiPath, JSON.stringify(openapi));

replaceExact(
  "apps/core/scripts/check-openapi.mjs",
  'if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.35.0") {',
  `if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "${kernelVersion}") {`,
  "Kernel status contract version assertion",
);

replaceRegex(
  "apps/core/scripts/check-openapi.mjs",
  /const calendarRequired = \[[\s\S]*?throw new Error\("Runtime Discovery Calendar Capability field-role binding drifted"\);\n\}/g,
  `const calendarVariants = calendarBinding?.oneOf;\nconst calendarFieldPattern = "${fieldPattern}";\nconst legacyCalendarRequired = [\n  "allDayField", "timedStartField", "timedEndField", "startTimezoneField",\n  "endTimezoneField", "allDayStartField", "allDayEndExclusiveField",\n];\nconst canonicalCalendarBinding = Array.isArray(calendarVariants)\n  ? calendarVariants.find((variant) => JSON.stringify(variant?.required) === JSON.stringify(["rangeField"]))\n  : null;\nconst legacyCalendarBinding = Array.isArray(calendarVariants)\n  ? calendarVariants.find((variant) => JSON.stringify(variant?.required) === JSON.stringify(legacyCalendarRequired))\n  : null;\nif (calendarBinding?.oneOf?.length !== 2\n    || canonicalCalendarBinding?.additionalProperties !== false\n    || canonicalCalendarBinding?.properties?.rangeField?.pattern !== calendarFieldPattern\n    || canonicalCalendarBinding?.properties?.attendeePersonField?.pattern !== calendarFieldPattern\n    || legacyCalendarBinding?.additionalProperties !== false\n    || legacyCalendarBinding?.deprecated !== true\n    || legacyCalendarRequired.some((key) => legacyCalendarBinding?.properties?.[key]?.pattern !== calendarFieldPattern)\n    || legacyCalendarBinding?.properties?.attendeePersonField?.pattern !== calendarFieldPattern) {\n  throw new Error("Runtime Discovery Calendar Capability canonical/legacy binding drifted");\n}\nconst semanticCalendarBinding = schemas.RuntimeModelSemanticCalendarBinding;\nif (JSON.stringify(semanticCalendarBinding) !== JSON.stringify(calendarBinding)) {\n  throw new Error("Runtime Discovery and static semantic Calendar binding schemas must stay identical");\n}`,
  "Calendar OpenAPI binding assertion",
);

replaceExact(
  "apps/core/src/app.ts",
  'contractVersion: "0.35.0",',
  `contractVersion: "${kernelVersion}",`,
  "Core status contract version",
);

const corePackagePath = "apps/core/package.json";
const corePackage = JSON.parse(read(corePackagePath));
corePackage.version = kernelVersion;
write(corePackagePath, `${JSON.stringify(corePackage, null, 2)}\n`);

replaceExact(
  "apps/core/AGENTS.md",
  "current Kernel version: 0.35.0",
  `current Kernel version: ${kernelVersion}`,
  "Core AGENTS Kernel version",
);

replaceExact(
  "README.md",
  "The current repository Core Kernel contract is **0.35.0**.",
  `The current repository Core Kernel contract is **${kernelVersion}**.`,
  "root README Kernel version",
);

replaceExact(
  "docs/architecture.md",
  "current Kernel contract: 0.35.0",
  `current Kernel contract: ${kernelVersion}`,
  "architecture Kernel version",
);

replaceExact(
  "docs/contracts.md",
  "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.35.0` owns neither Model Registry governance nor Eventing wire representation.",
  `The checked-in contract is \`apps/core/openapi.yaml\`; Kernel \`${kernelVersion}\` owns neither Model Registry governance nor Eventing wire representation.`,
  "contracts current Kernel version",
);

replaceExact(
  "docs/contracts.md",
  "Core Kernel `0.35.0` adds the preferred grouped `calendar.window` viewing-window semantic query",
  "Core Kernel `0.36.0` evolves Calendar Capability bindings to make one `temporal_range` field the canonical Calendar time truth. Runtime Discovery and progressive static semantic detail now expose Calendar binding as a canonical `{ rangeField, attendeePersonField? }` shape while retaining the prior split-field binding only for historical published Model Definitions. Canonical Calendar models use the normal Canonical Query surface over the bound TemporalRange field; legacy `calendar.window` and split-field GET transport remain compatibility behavior only for historical definitions. Event v6 is the first shipped model using this representation.\n\nCore Kernel `0.35.0` adds the preferred grouped `calendar.window` viewing-window semantic query",
  "contracts 0.36 release note insertion",
);

const profilePath = "infra/homemew-integration-profile.json";
const profile = JSON.parse(read(profilePath));
profile.contracts.coreKernel = kernelVersion;
write(profilePath, `${JSON.stringify(profile, null, 2)}\n`);

replaceExact(
  "apps/core/src/model-admin-ai-provider.ts",
  "Calendar is only for timed/all-day calendar interval semantics. Its config maps:\n{ allDayField, timedStartField, timedEndField, startTimezoneField, endTimezoneField, allDayStartField, allDayEndExclusiveField, optional attendeePersonField }.\nDo not invent any other capability key.",
  "Calendar is only for timed/all-day calendar interval semantics. New/current models map one declared temporal_range field using:\n{ rangeField, optional attendeePersonField }.\nThe legacy seven split Calendar fields are historical compatibility syntax and must not be proposed for new/current models.\nDo not invent any other capability key.",
  "Model Admin AI Calendar guidance",
);

replaceExact(
  "docs/generic-consumer-readiness-v1.md",
  "for example `calendar.timedStartField`",
  "for example canonical `calendar.rangeField` (or legacy split-field roles when inspecting a historical model version)",
  "generic consumer Calendar binding example",
);

replaceExact(
  "docs/model-definition-spec.md",
  "- Calendar Capability bindings remain authoritative for Calendar timed and all-day intervals. A model with Calendar must not redeclare the Calendar-owned `timedStartField/timedEndField` or `allDayStartField/allDayEndExclusiveField` pair in `timeRanges`; progressive semantic projection derives those ranges directly from the Capability binding;",
  "- Calendar Capability bindings remain authoritative for Calendar intervals. Current Calendar models bind one `temporal_range` field through `rangeField`; progressive semantic projection derives that interval directly from the Capability binding. Historical split-field Calendar definitions retain their derived timed/all-day ranges for compatibility and must not redeclare those legacy pairs in `timeRanges`;",
  "Model Definition timeRanges Calendar rule",
);

replaceRegex(
  "docs/model-definition-spec.md",
  /### 14\.2 Calendar Capability[\s\S]*?Conformance-ID: MDV1-CAPABILITY-CALENDAR-WINDOW-01/g,
  `### 14.2 Calendar Capability\n\nCurrent/canonical configuration:\n\n\`\`\`ts\ncapabilities: {\n  calendar: {\n    rangeField: string,\n    attendeePersonField?: string\n  }\n}\n\`\`\`\n\nField contracts:\n\n- \`rangeField\` must name one declared \`temporal_range\` field;\n- optional attendees must name a \`person_list\` field;\n- the bound TemporalRange is the single Calendar time truth. Date and Instant variants are represented by the canonical tagged value and are validated/persisted by Generic Runtime;\n- Calendar adds semantic role/context around that field but does not create a second time representation.\n\nCurrent Model Definitions must use this canonical binding. The validator/runtime also retain the prior split-field binding:\n\n\`\`\`ts\n{\n  allDayField,\n  timedStartField,\n  timedEndField,\n  startTimezoneField,\n  endTimezoneField,\n  allDayStartField,\n  allDayEndExclusiveField,\n  attendeePersonField?\n}\n\`\`\`\n\nThat shape exists only so already-published historical Model Definitions remain interpretable during migration. A Calendar definition must use either \`rangeField\` or the complete legacy split binding, never both. New baseline models and AI-generated proposals must not introduce the legacy shape.\n\nRuntime Discovery and progressive static semantic detail project the same canonical/legacy union. Generic consumers inspect the returned binding instead of guessing Event field names. For current models, \`rangeField\` points directly at the authoritative \`temporal_range\` field. The projection contains no UI layout semantics and never replaces execution-time validation.\n\nConformance-ID: MDV1-CAPABILITY-CALENDAR-01\n\nCanonical Calendar query behavior is the normal Canonical Query behavior of the bound TemporalRange field. Overlap/filter/sort predicates therefore target \`rangeField\`, and TemporalRange sort requires explicit \`context.viewingTimezone\`. Relative-language inputs such as \`today\` or \`tomorrow\` remain caller/Agent concerns and are resolved to concrete Canonical Query values before execution.\n\nThe historical split-field Calendar engine retains its previous grouped \`calendar.window\`, \`rangeStart/rangeEnd\`, \`dateStart/dateEndExclusive\` and \`calendarStart\` semantics only for historical published definitions. Canonical Calendar models do not expose or execute that legacy query transport.\n\nConformance-ID: MDV1-CAPABILITY-CALENDAR-WINDOW-01`,
  "Model Definition Calendar section",
);

console.log("Phase 4 Calendar contract/docs synchronization complete");

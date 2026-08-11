import type { FieldDefinition, ModelValidationIssue } from "./model-definition";

export type TemporalCapabilityDefinition = {
  kindField: string;
  anchorDateField: string;
  cycleDaysField: string;
  attentionBeforeDaysField: string;
  attentionAfterDaysField: string;
  statusField: string;
  occurrences?: boolean;
};

export type CapabilityDefinitions = {
  temporal?: TemporalCapabilityDefinition;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ModelValidationIssue[], path: string, code: string, message: string) {
  issues.push({ path, code, message });
}

function field(
  raw: Record<string, unknown>,
  property: keyof TemporalCapabilityDefinition,
  fields: Record<string, FieldDefinition>,
  expectedTypes: string[],
  issues: ModelValidationIssue[],
): string {
  const value = raw[property];
  const path = `capabilities.temporal.${property}`;
  if (typeof value !== "string" || !value) {
    issue(issues, path, "CAPABILITY_FIELD_REQUIRED", `${property} must name a declared model field`);
    return "";
  }
  const definition = fields[value];
  if (!definition) {
    issue(issues, path, "UNKNOWN_CAPABILITY_FIELD", `${value} is not a declared model field`);
    return value;
  }
  if (!expectedTypes.includes(definition.type)) {
    issue(issues, path, "INVALID_CAPABILITY_FIELD_TYPE", `${value} must use ${expectedTypes.join(" or ")}`);
  }
  return value;
}

function validateTemporal(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
): { definition?: TemporalCapabilityDefinition; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  if (!isObject(raw)) {
    issue(issues, "capabilities.temporal", "INVALID_CAPABILITY", "temporal capability config must be an object");
    return { issues };
  }
  const allowed = new Set([
    "kindField",
    "anchorDateField",
    "cycleDaysField",
    "attentionBeforeDaysField",
    "attentionAfterDaysField",
    "statusField",
    "occurrences",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) issue(issues, `capabilities.temporal.${key}`, "UNKNOWN_PROPERTY", `Unsupported temporal capability property ${key}`);
  }

  const kindField = field(raw, "kindField", fields, ["enum"], issues);
  const anchorDateField = field(raw, "anchorDateField", fields, ["date"], issues);
  const cycleDaysField = field(raw, "cycleDaysField", fields, ["integer"], issues);
  const attentionBeforeDaysField = field(raw, "attentionBeforeDaysField", fields, ["integer"], issues);
  const attentionAfterDaysField = field(raw, "attentionAfterDaysField", fields, ["integer"], issues);
  const statusField = field(raw, "statusField", fields, ["enum"], issues);

  const kindDefinition = fields[kindField];
  if (kindDefinition?.type === "enum" && !["elapsed", "countdown", "cycle"].every((value) => kindDefinition.values?.includes(value))) {
    issue(issues, `capabilities.temporal.kindField`, "INVALID_TEMPORAL_KIND_ENUM", "Temporal kind field must include elapsed, countdown, and cycle");
  }
  const statusDefinition = fields[statusField];
  if (statusDefinition?.type === "enum" && !["active", "archived"].every((value) => statusDefinition.values?.includes(value))) {
    issue(issues, `capabilities.temporal.statusField`, "INVALID_TEMPORAL_STATUS_ENUM", "Temporal status field must include active and archived");
  }
  const cycleDefinition = fields[cycleDaysField];
  if (cycleDefinition && cycleDefinition.minimum !== undefined && cycleDefinition.minimum < 1) {
    issue(issues, `capabilities.temporal.cycleDaysField`, "INVALID_TEMPORAL_CONSTRAINT", "cycleDays minimum must be at least 1");
  }
  const beforeDefinition = fields[attentionBeforeDaysField];
  if (beforeDefinition && beforeDefinition.minimum !== undefined && beforeDefinition.minimum < 0) {
    issue(issues, `capabilities.temporal.attentionBeforeDaysField`, "INVALID_TEMPORAL_CONSTRAINT", "attentionBeforeDays minimum must be at least 0");
  }
  const afterDefinition = fields[attentionAfterDaysField];
  if (afterDefinition && afterDefinition.minimum !== undefined && afterDefinition.minimum < 1) {
    issue(issues, `capabilities.temporal.attentionAfterDaysField`, "INVALID_TEMPORAL_CONSTRAINT", "attentionAfterDays minimum must be at least 1");
  }
  if (raw.occurrences !== undefined && typeof raw.occurrences !== "boolean") {
    issue(issues, "capabilities.temporal.occurrences", "INVALID_BOOLEAN", "occurrences must be boolean");
  }

  if (issues.length) return { issues };
  return {
    definition: {
      kindField,
      anchorDateField,
      cycleDaysField,
      attentionBeforeDaysField,
      attentionAfterDaysField,
      statusField,
      ...(raw.occurrences === undefined ? {} : { occurrences: raw.occurrences as boolean }),
    },
    issues,
  };
}

export function validateCapabilities(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
): { capabilities?: CapabilityDefinitions; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  if (raw === undefined) return { issues };
  if (!isObject(raw)) {
    if (Array.isArray(raw)) {
      for (const capability of raw) issue(issues, "capabilities", "UNSUPPORTED_CAPABILITY", `Capability ${String(capability)} is not registered in object-form capability metadata`);
    } else {
      issue(issues, "capabilities", "INVALID_CAPABILITIES", "capabilities must be an object keyed by registered capability name");
    }
    return { issues };
  }

  for (const key of Object.keys(raw)) {
    if (key !== "temporal") issue(issues, `capabilities.${key}`, "UNSUPPORTED_CAPABILITY", `Capability ${key} is not registered`);
  }

  const capabilities: CapabilityDefinitions = {};
  if (raw.temporal !== undefined) {
    const temporal = validateTemporal(raw.temporal, fields);
    issues.push(...temporal.issues);
    if (temporal.definition) capabilities.temporal = temporal.definition;
  }
  return { ...(Object.keys(capabilities).length ? { capabilities } : {}), issues };
}

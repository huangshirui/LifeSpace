import { validateRecurrenceCapability, type RecurrenceCapabilityDefinition } from "./recurrence-definition";
import type { FieldDefinition, ModelValidationIssue } from "./model-definition";

export type TemporalCapabilityDefinition = {
  kindField: string;
  anchorDateField: string;
  cycleDaysField: string;
  attentionBeforeDaysField: string;
  attentionAfterDaysField: string;
  statusField: string;
  subjectPersonField?: string;
  occurrences?: boolean;
};

export type LegacyCalendarCapabilityDefinition = {
  allDayField: string;
  timedStartField: string;
  timedEndField: string;
  startTimezoneField: string;
  endTimezoneField: string;
  allDayStartField: string;
  allDayEndExclusiveField: string;
  attendeePersonField?: string;
};

export type CanonicalCalendarCapabilityDefinition = {
  rangeField: string;
  attendeePersonField?: string;
};

export type CalendarCapabilityDefinition = LegacyCalendarCapabilityDefinition | CanonicalCalendarCapabilityDefinition;

export function isCanonicalCalendarCapability(
  definition: CalendarCapabilityDefinition,
): definition is CanonicalCalendarCapabilityDefinition {
  return "rangeField" in definition;
}

export type CheckInCapabilityDefinition = {
  intervalDaysField: string;
  lastCheckInDateField: string;
  streakStartDateField: string;
  statusField?: string;
  allowedStatuses?: string[];
};

export type CapabilityDefinitions = {
  checkIn?: CheckInCapabilityDefinition;
  recurrence?: RecurrenceCapabilityDefinition;
  temporal?: TemporalCapabilityDefinition;
  calendar?: CalendarCapabilityDefinition;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(issues: ModelValidationIssue[], path: string, code: string, message: string) {
  issues.push({ path, code, message });
}

function namedField(
  raw: Record<string, unknown>,
  capability: "temporal" | "calendar",
  property: string,
  fields: Record<string, FieldDefinition>,
  expectedTypes: string[],
  issues: ModelValidationIssue[],
): string {
  const value = raw[property];
  const path = `capabilities.${capability}.${property}`;
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
    "kindField", "anchorDateField", "cycleDaysField", "attentionBeforeDaysField",
    "attentionAfterDaysField", "statusField", "subjectPersonField", "occurrences",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) issue(issues, `capabilities.temporal.${key}`, "UNKNOWN_PROPERTY", `Unsupported temporal capability property ${key}`);
  }

  const kindField = namedField(raw, "temporal", "kindField", fields, ["enum"], issues);
  const anchorDateField = namedField(raw, "temporal", "anchorDateField", fields, ["date"], issues);
  const cycleDaysField = namedField(raw, "temporal", "cycleDaysField", fields, ["integer"], issues);
  const attentionBeforeDaysField = namedField(raw, "temporal", "attentionBeforeDaysField", fields, ["integer"], issues);
  const attentionAfterDaysField = namedField(raw, "temporal", "attentionAfterDaysField", fields, ["integer"], issues);
  const statusField = namedField(raw, "temporal", "statusField", fields, ["enum"], issues);
  const subjectPersonField = raw.subjectPersonField === undefined
    ? undefined
    : namedField(raw, "temporal", "subjectPersonField", fields, ["person"], issues);

  const kindDefinition = fields[kindField];
  if (kindDefinition?.type === "enum" && !["elapsed", "countdown", "cycle"].every((value) => kindDefinition.values?.includes(value))) {
    issue(issues, "capabilities.temporal.kindField", "INVALID_TEMPORAL_KIND_ENUM", "Temporal kind field must include elapsed, countdown, and cycle");
  }
  const statusDefinition = fields[statusField];
  if (statusDefinition?.type === "enum" && !["active", "archived"].every((value) => statusDefinition.values?.includes(value))) {
    issue(issues, "capabilities.temporal.statusField", "INVALID_TEMPORAL_STATUS_ENUM", "Temporal status field must include active and archived");
  }
  if (raw.occurrences !== undefined && typeof raw.occurrences !== "boolean") {
    issue(issues, "capabilities.temporal.occurrences", "INVALID_BOOLEAN", "occurrences must be boolean");
  }
  if (issues.length) return { issues };
  return {
    definition: {
      kindField, anchorDateField, cycleDaysField, attentionBeforeDaysField, attentionAfterDaysField, statusField,
      ...(subjectPersonField ? { subjectPersonField } : {}),
      ...(raw.occurrences === undefined ? {} : { occurrences: raw.occurrences as boolean }),
    },
    issues,
  };
}

function validateCalendar(
  raw: unknown,
  fields: Record<string, FieldDefinition>,
): { definition?: CalendarCapabilityDefinition; issues: ModelValidationIssue[] } {
  const issues: ModelValidationIssue[] = [];
  if (!isObject(raw)) {
    issue(issues, "capabilities.calendar", "INVALID_CAPABILITY", "calendar capability config must be an object");
    return { issues };
  }
  const legacyProperties = [
    "allDayField", "timedStartField", "timedEndField", "startTimezoneField", "endTimezoneField",
    "allDayStartField", "allDayEndExclusiveField",
  ] as const;
  const allowed = new Set<string>(["rangeField", ...legacyProperties, "attendeePersonField"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) issue(issues, `capabilities.calendar.${key}`, "UNKNOWN_PROPERTY", `Unsupported calendar capability property ${key}`);
  }

  const hasCanonicalRange = raw.rangeField !== undefined;
  const hasLegacyBinding = legacyProperties.some((property) => raw[property] !== undefined);
  if (hasCanonicalRange && hasLegacyBinding) {
    issue(
      issues,
      "capabilities.calendar",
      "MIXED_CALENDAR_BINDING",
      "Calendar must bind either one temporal_range rangeField or the legacy split fields, not both",
    );
  }

  const attendeePersonField = raw.attendeePersonField === undefined
    ? undefined
    : namedField(raw, "calendar", "attendeePersonField", fields, ["person_list"], issues);

  if (hasCanonicalRange) {
    const rangeField = namedField(raw, "calendar", "rangeField", fields, ["temporal_range"], issues);
    if (issues.length) return { issues };
    return {
      definition: {
        rangeField,
        ...(attendeePersonField ? { attendeePersonField } : {}),
      },
      issues,
    };
  }

  const allDayField = namedField(raw, "calendar", "allDayField", fields, ["boolean"], issues);
  const timedStartField = namedField(raw, "calendar", "timedStartField", fields, ["instant", "datetime"], issues);
  const timedEndField = namedField(raw, "calendar", "timedEndField", fields, ["instant", "datetime"], issues);
  const startTimezoneField = namedField(raw, "calendar", "startTimezoneField", fields, ["timezone"], issues);
  const endTimezoneField = namedField(raw, "calendar", "endTimezoneField", fields, ["timezone"], issues);
  const allDayStartField = namedField(raw, "calendar", "allDayStartField", fields, ["date"], issues);
  const allDayEndExclusiveField = namedField(raw, "calendar", "allDayEndExclusiveField", fields, ["date"], issues);
  const coreFields = [allDayField, timedStartField, timedEndField, startTimezoneField, endTimezoneField, allDayStartField, allDayEndExclusiveField].filter(Boolean);
  if (new Set(coreFields).size !== coreFields.length) {
    issue(issues, "capabilities.calendar", "DUPLICATE_CAPABILITY_FIELD", "Calendar core fields must map to distinct model fields");
  }
  if (issues.length) return { issues };
  return {
    definition: {
      allDayField, timedStartField, timedEndField, startTimezoneField, endTimezoneField,
      allDayStartField, allDayEndExclusiveField, ...(attendeePersonField ? { attendeePersonField } : {}),
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
    if (key !== "temporal" && key !== "calendar" && key !== "recurrence" && key !== "checkIn") issue(issues, `capabilities.${key}`, "UNSUPPORTED_CAPABILITY", `Capability ${key} is not registered`);
  }
  const capabilities: CapabilityDefinitions = {};
  if (raw.temporal !== undefined) {
    const temporal = validateTemporal(raw.temporal, fields);
    issues.push(...temporal.issues);
    if (temporal.definition) capabilities.temporal = temporal.definition;
  }
  if (raw.calendar !== undefined) {
    const calendar = validateCalendar(raw.calendar, fields);
    issues.push(...calendar.issues);
    if (calendar.definition) capabilities.calendar = calendar.definition;
  }
  if (raw.recurrence !== undefined) {
    const recurrence = validateRecurrenceCapability(raw.recurrence, fields);
    issues.push(...recurrence.issues);
    if (recurrence.definition) capabilities.recurrence = recurrence.definition;
  }
  if (raw.checkIn !== undefined) {
    const entry = raw.checkIn, base = "capabilities.checkIn";
    if (!isObject(entry)) {
      issue(issues, base, "INVALID_CAPABILITY", "checkIn must be an object");
    } else {
      const names = ["intervalDaysField", "lastCheckInDateField", "streakStartDateField"] as const;
      const allowedKeys = new Set<string>([...names, "statusField", "allowedStatuses"]);
      for (const key of Object.keys(entry)) {
        if (!allowedKeys.has(key)) issue(issues, base + "." + key, "UNKNOWN_PROPERTY", "Unknown checkIn binding");
      }
      const [intervalName, lastName, startName] = names.map((key) => entry[key]);
      if ([intervalName, lastName, startName].some((v) => typeof v !== "string" || !v)
        || new Set([intervalName, lastName, startName]).size !== 3) {
        issue(issues, base, "INVALID_CAPABILITY_FIELDS", "checkIn must bind three distinct declared fields");
      } else {
        const interval = fields[intervalName as string], last = fields[lastName as string], start = fields[startName as string];
        if (!interval || interval.type !== "integer" || !interval.required || !interval.immutable || interval.readOnly
          || (interval.minimum ?? 0) < 1) {
          issue(issues, base + ".intervalDaysField", "INVALID_CAPABILITY_FIELD", "Interval must be a required immutable integer with minimum >= 1");
        }
        if (!last || last.type !== "date" || !last.readOnly || !last.nullable || last.immutable) {
          issue(issues, base + ".lastCheckInDateField", "INVALID_CAPABILITY_FIELD", "Last check-in must be a read-only nullable date");
        }
        if (!start || start.type !== "date" || !start.readOnly || !start.nullable || start.immutable) {
          issue(issues, base + ".streakStartDateField", "INVALID_CAPABILITY_FIELD", "Streak start must be a read-only nullable date");
        }
        const hasStatus = entry.statusField !== undefined || entry.allowedStatuses !== undefined;
        if (hasStatus) {
          const statusName = entry.statusField;
          const allowed = entry.allowedStatuses;
          const status = typeof statusName === "string" ? fields[statusName] : undefined;
          if (!status || status.type !== "enum" || !status.required || !status.readOnly) {
            issue(issues, base + ".statusField", "INVALID_CAPABILITY_FIELD", "Status must bind a required read-only enum");
          }
          if (!Array.isArray(allowed) || !allowed.length || allowed.length > 50
            || allowed.some((value) => typeof value !== "string" || !status?.values?.includes(value))
            || new Set(allowed).size !== allowed.length) {
            issue(issues, base + ".allowedStatuses", "INVALID_CAPABILITY_STATUSES", "Allowed statuses must be unique declared enum values");
          }
          if ([intervalName, lastName, startName].includes(statusName)) {
            issue(issues, base + ".statusField", "DUPLICATE_CAPABILITY_FIELD", "Status must bind a distinct field");
          }
        }
        if (interval && last && start && !issues.some((v) => v.path.startsWith(base))) {
          capabilities.checkIn = {
            intervalDaysField: intervalName as string,
            lastCheckInDateField: lastName as string,
            streakStartDateField: startName as string,
            ...(hasStatus ? { statusField: entry.statusField as string, allowedStatuses: entry.allowedStatuses as string[] } : {}),
          };
        }
      }
    }
  }
  if (capabilities.checkIn && (capabilities.temporal || capabilities.calendar)) {
    issue(issues, "capabilities.checkIn", "CAPABILITY_CONFLICT", "Check-in cannot share a model with Temporal or Calendar");
  }
  return { ...(Object.keys(capabilities).length ? { capabilities } : {}), issues };
}

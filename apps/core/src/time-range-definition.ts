const TIME_RANGE_KEY = /^[a-z][A-Za-z0-9]{0,62}$/;
const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,62}$/;

export const TIME_RANGE_BOUNDS = ["[]", "[)", "(]", "()"] as const;
export type TimeRangeBounds = typeof TIME_RANGE_BOUNDS[number];

export type TimeRangeDefinition = {
  startField: string;
  endField: string;
  bounds: TimeRangeBounds;
};

export type TimeRangeDefinitions = Record<string, TimeRangeDefinition>;

export type TimeRangeValidationIssue = {
  path: string;
  code: string;
  message: string;
};

export type TimeRangeValidationResult = {
  timeRanges?: TimeRangeDefinitions;
  issues: TimeRangeValidationIssue[];
};

type FieldLike = {
  type: string;
};

type CalendarBindingLike = {
  timedStartField: string;
  timedEndField: string;
  allDayStartField: string;
  allDayEndExclusiveField: string;
};

type TimeRangeSemanticInput = {
  fields: Record<string, FieldLike>;
  timeRanges?: TimeRangeDefinitions;
  capabilities?: {
    calendar?: CalendarBindingLike;
  };
};

export type TimeRangeSemantic = {
  key: string;
  startField: string;
  endField: string;
  valueType: "date" | "instant";
  bounds: TimeRangeBounds;
  source: "model" | "capability";
  capability?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function issue(
  issues: TimeRangeValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function pairKey(startField: string, endField: string): string {
  return [startField, endField].sort().join("\u0000");
}

export function validateTimeRanges(
  raw: unknown,
  fields: Record<string, FieldLike>,
): TimeRangeValidationResult {
  if (raw === undefined) return { issues: [] };
  const issues: TimeRangeValidationIssue[] = [];
  if (!isObject(raw)) {
    issue(issues, "timeRanges", "INVALID_TIME_RANGES", "timeRanges must be an object");
    return { issues };
  }

  const entries = Object.entries(raw);
  if (entries.length === 0) {
    issue(issues, "timeRanges", "EMPTY_TIME_RANGES", "timeRanges must contain at least one range when present");
  }
  if (entries.length > 16) {
    issue(issues, "timeRanges", "TOO_MANY_TIME_RANGES", "A model may declare at most 16 time ranges");
  }

  const timeRanges: TimeRangeDefinitions = {};
  const seenPairs = new Map<string, string>();
  for (const [rangeKey, rawRange] of entries) {
    const path = `timeRanges.${rangeKey}`;
    const startIssueCount = issues.length;
    if (!TIME_RANGE_KEY.test(rangeKey)) {
      issue(issues, path, "INVALID_TIME_RANGE_KEY", `${rangeKey} is not a valid time range key`);
    }
    if (!isObject(rawRange)) {
      issue(issues, path, "INVALID_TIME_RANGE", `${path} must be an object`);
      continue;
    }
    for (const property of Object.keys(rawRange)) {
      if (property !== "startField" && property !== "endField" && property !== "bounds") {
        issue(issues, `${path}.${property}`, "UNKNOWN_PROPERTY", `Unsupported time range property ${property}`);
      }
    }

    const startField = typeof rawRange.startField === "string" ? rawRange.startField : "";
    const endField = typeof rawRange.endField === "string" ? rawRange.endField : "";
    if (!FIELD_KEY.test(startField)) {
      issue(issues, `${path}.startField`, "INVALID_TIME_RANGE_FIELD", "startField must be a valid field key");
    }
    if (!FIELD_KEY.test(endField)) {
      issue(issues, `${path}.endField`, "INVALID_TIME_RANGE_FIELD", "endField must be a valid field key");
    }
    if (startField && endField && startField === endField) {
      issue(issues, path, "TIME_RANGE_FIELDS_NOT_DISTINCT", "startField and endField must be distinct");
    }

    const startDefinition = fields[startField];
    const endDefinition = fields[endField];
    if (startField && !startDefinition) {
      issue(issues, `${path}.startField`, "UNKNOWN_TIME_RANGE_FIELD", `${startField} is not a declared field`);
    }
    if (endField && !endDefinition) {
      issue(issues, `${path}.endField`, "UNKNOWN_TIME_RANGE_FIELD", `${endField} is not a declared field`);
    }
    const semanticTimeType = (definition: FieldLike | undefined): "date" | "instant" | null => {
      if (definition?.type === "date") return "date";
      if (definition?.type === "instant" || definition?.type === "datetime") return "instant";
      return null;
    };
    const startSemanticType = semanticTimeType(startDefinition);
    const endSemanticType = semanticTimeType(endDefinition);
    if (startDefinition && !startSemanticType) {
      issue(issues, `${path}.startField`, "INVALID_TIME_RANGE_FIELD_TYPE", "startField must be Date or Instant");
    }
    if (endDefinition && !endSemanticType) {
      issue(issues, `${path}.endField`, "INVALID_TIME_RANGE_FIELD_TYPE", "endField must be Date or Instant");
    }
    if (startSemanticType && endSemanticType && startSemanticType !== endSemanticType) {
      issue(issues, path, "MISMATCHED_TIME_RANGE_FIELD_TYPES", "startField and endField must have the same Date/Instant semantic type");
    }

    const bounds = rawRange.bounds === undefined ? "[)" : rawRange.bounds;
    if (typeof bounds !== "string" || !TIME_RANGE_BOUNDS.includes(bounds as TimeRangeBounds)) {
      issue(issues, `${path}.bounds`, "INVALID_TIME_RANGE_BOUNDS", "bounds must be one of [], [), (], ()");
    }

    if (startField && endField && startField !== endField) {
      const pair = pairKey(startField, endField);
      const previous = seenPairs.get(pair);
      if (previous) {
        issue(issues, path, "DUPLICATE_TIME_RANGE_BINDING", `Field pair is already bound by timeRanges.${previous}`);
      } else {
        seenPairs.set(pair, rangeKey);
      }
    }

    if (issues.length === startIssueCount) {
      timeRanges[rangeKey] = {
        startField,
        endField,
        bounds: bounds as TimeRangeBounds,
      };
    }
  }

  return {
    ...(Object.keys(timeRanges).length ? { timeRanges } : {}),
    issues,
  };
}

export function validateCalendarTimeRangeCollisions(
  timeRanges: TimeRangeDefinitions | undefined,
  calendar: CalendarBindingLike | undefined,
): TimeRangeValidationIssue[] {
  if (!timeRanges || !calendar) return [];
  const ownedPairs = new Map([
    [pairKey(calendar.timedStartField, calendar.timedEndField), "Calendar timed range"],
    [pairKey(calendar.allDayStartField, calendar.allDayEndExclusiveField), "Calendar all-day range"],
  ]);
  const issues: TimeRangeValidationIssue[] = [];
  for (const [rangeKey, range] of Object.entries(timeRanges)) {
    const owner = ownedPairs.get(pairKey(range.startField, range.endField));
    if (owner) {
      issue(
        issues,
        `timeRanges.${rangeKey}`,
        "CAPABILITY_TIME_RANGE_COLLISION",
        `${owner} is authoritative and must not be redeclared in timeRanges`,
      );
    }
  }
  return issues;
}

export function projectTimeRangeSemantics(definition: TimeRangeSemanticInput): TimeRangeSemantic[] {
  const projected: TimeRangeSemantic[] = Object.entries(definition.timeRanges ?? {}).map(([key, range]) => ({
    key,
    startField: range.startField,
    endField: range.endField,
    valueType: definition.fields[range.startField]!.type === "date" ? "date" : "instant",
    bounds: range.bounds,
    source: "model",
  }));

  const calendar = definition.capabilities?.calendar;
  if (calendar) {
    projected.push(
      {
        key: "calendar.timed",
        startField: calendar.timedStartField,
        endField: calendar.timedEndField,
        valueType: "instant",
        bounds: "[)",
        source: "capability",
        capability: "calendar",
      },
      {
        key: "calendar.allDay",
        startField: calendar.allDayStartField,
        endField: calendar.allDayEndExclusiveField,
        valueType: "date",
        bounds: "[)",
        source: "capability",
        capability: "calendar",
      },
    );
  }

  return projected.sort((left, right) => left.key.localeCompare(right.key));
}

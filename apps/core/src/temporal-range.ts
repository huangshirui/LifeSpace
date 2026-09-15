export const TEMPORAL_RANGE_KINDS = ["date", "datetime"] as const;

export type TemporalRangeKind = typeof TEMPORAL_RANGE_KINDS[number];

export type TemporalRangeValue =
  | {
      kind: "date";
      start: string;
      endExclusive: string;
    }
  | {
      kind: "datetime";
      start: string;
      endExclusive: string;
    };

export type TemporalRangeValidationIssue = {
  code: string;
  message: string;
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day;
}

function validDateTime(value: string): boolean {
  return Boolean(value)
    && /T/.test(value)
    && !Number.isNaN(Date.parse(value));
}

export function validateTemporalRangeValue(
  value: unknown,
): { valid: true; value: TemporalRangeValue } | { valid: false; issues: TemporalRangeValidationIssue[] } {
  const issues: TemporalRangeValidationIssue[] = [];

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_TEMPORAL_RANGE", message: "Temporal range must be an object" }],
    };
  }

  const input = value as Record<string, unknown>;
  const kind = input.kind;
  const start = input.start;
  const endExclusive = input.endExclusive;

  if (kind !== "date" && kind !== "datetime") {
    issues.push({ code: "INVALID_KIND", message: "Temporal range kind must be date or datetime" });
  }

  if (typeof start !== "string" || typeof endExclusive !== "string") {
    issues.push({ code: "INVALID_BOUND", message: "Temporal range boundaries must be strings" });
  } else if (kind === "date") {
    if (!validDate(start) || !validDate(endExclusive)) {
      issues.push({ code: "INVALID_DATE", message: "Date temporal range boundaries are invalid" });
    }
  } else if (kind === "datetime") {
    if (!validDateTime(start) || !validDateTime(endExclusive)) {
      issues.push({ code: "INVALID_DATETIME", message: "Datetime temporal range boundaries are invalid" });
    }
  }

  if (issues.length) return { valid: false, issues };

  if (start >= endExclusive) {
    return {
      valid: false,
      issues: [{ code: "INVALID_ORDER", message: "Temporal range start must be before endExclusive" }],
    };
  }

  return {
    valid: true,
    value: {
      kind,
      start,
      endExclusive,
    } as TemporalRangeValue,
  };
}

export function compareTemporalRange(
  left: TemporalRangeValue,
  right: TemporalRangeValue,
): number {
  return left.start.localeCompare(right.start)
    || left.endExclusive.localeCompare(right.endExclusive);
}

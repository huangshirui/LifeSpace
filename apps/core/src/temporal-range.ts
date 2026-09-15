import { normalizeRfc3339Instant } from "./time-semantics";

export const TEMPORAL_RANGE_KINDS = ["date", "instant"] as const;

export type TemporalRangeKind = typeof TEMPORAL_RANGE_KINDS[number];

export type TemporalRangeValue =
  | {
      kind: "date";
      start: string;
      endExclusive: string;
    }
  | {
      kind: "instant";
      start: string;
      endExclusive: string;
    };

export type TemporalRangeValidationIssue = {
  code: string;
  message: string;
};

const TEMPORAL_RANGE_PROPERTIES = new Set(["kind", "start", "endExclusive"]);

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() + 1 === month
    && parsed.getUTCDate() === day;
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
  for (const property of Object.keys(input)) {
    if (!TEMPORAL_RANGE_PROPERTIES.has(property)) {
      issues.push({ code: "UNKNOWN_PROPERTY", message: `Unsupported temporal range property ${property}` });
    }
  }

  const kind = input.kind;
  const start = input.start;
  const endExclusive = input.endExclusive;

  if (kind !== "date" && kind !== "instant") {
    issues.push({ code: "INVALID_KIND", message: "Temporal range kind must be date or instant" });
  }

  if (typeof start !== "string" || typeof endExclusive !== "string") {
    issues.push({ code: "INVALID_BOUND", message: "Temporal range boundaries must be strings" });
  }

  if (issues.length) return { valid: false, issues };

  let normalizedStart = start as string;
  let normalizedEnd = endExclusive as string;
  if (kind === "date") {
    if (!validDate(normalizedStart) || !validDate(normalizedEnd)) {
      return {
        valid: false,
        issues: [{ code: "INVALID_DATE", message: "Date temporal range boundaries are invalid" }],
      };
    }
  } else {
    try {
      normalizedStart = normalizeRfc3339Instant(normalizedStart);
      normalizedEnd = normalizeRfc3339Instant(normalizedEnd);
    } catch {
      return {
        valid: false,
        issues: [{ code: "INVALID_INSTANT", message: "Instant temporal range boundaries must be absolute RFC 3339 date-times" }],
      };
    }
  }

  if (normalizedStart >= normalizedEnd) {
    return {
      valid: false,
      issues: [{ code: "INVALID_ORDER", message: "Temporal range start must be before endExclusive" }],
    };
  }

  return {
    valid: true,
    value: {
      kind,
      start: normalizedStart,
      endExclusive: normalizedEnd,
    } as TemporalRangeValue,
  };
}

export function compareTemporalRange(
  left: TemporalRangeValue,
  right: TemporalRangeValue,
): number {
  if (left.kind !== right.kind) {
    throw new RangeError("Mixed TemporalRange variants require an explicit viewing timezone projection");
  }
  const leftStart = left.kind === "instant" ? normalizeRfc3339Instant(left.start) : left.start;
  const rightStart = right.kind === "instant" ? normalizeRfc3339Instant(right.start) : right.start;
  const leftEnd = left.kind === "instant" ? normalizeRfc3339Instant(left.endExclusive) : left.endExclusive;
  const rightEnd = right.kind === "instant" ? normalizeRfc3339Instant(right.endExclusive) : right.endExclusive;
  return leftStart.localeCompare(rightStart) || leftEnd.localeCompare(rightEnd);
}

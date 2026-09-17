import { validateTemporalRangeValue } from "./temporal-range";

export type RangeValueType = "date" | "instant";

export type RangeValue = {
  start: string;
  endExclusive: string;
};

export type RangeValidationIssue = {
  code: string;
  message: string;
};

const RANGE_PROPERTIES = new Set(["start", "endExclusive"]);

export function validateRangeValue(
  value: unknown,
  valueType: RangeValueType,
): { valid: true; value: RangeValue } | { valid: false; issues: RangeValidationIssue[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      issues: [{ code: "INVALID_RANGE", message: "Range must be an object" }],
    };
  }

  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((property) => !RANGE_PROPERTIES.has(property));
  if (unknown.length) {
    return {
      valid: false,
      issues: unknown.map((property) => ({
        code: "UNKNOWN_PROPERTY",
        message: `Unsupported range property ${property}`,
      })),
    };
  }

  const validated = validateTemporalRangeValue({
    kind: valueType,
    start: input.start,
    endExclusive: input.endExclusive,
  });
  if (!validated.valid) return validated;

  return {
    valid: true,
    value: {
      start: validated.value.start,
      endExclusive: validated.value.endExclusive,
    },
  };
}

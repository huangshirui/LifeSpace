const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u;
const SEARCH_PADDING_MS = 48 * 60 * 60 * 1000;

export type LocalDateWindow = {
  dateStart: string;
  dateEndExclusive: string;
  timezone: string;
};

export type InstantRange = {
  startInclusive: string;
  endExclusive: string;
};

export function normalizeRfc3339Instant(value: unknown): string {
  if (typeof value !== "string" || !RFC3339_INSTANT.test(value)) {
    throw new RangeError("instant must be an absolute RFC 3339 date-time");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError("instant must be an absolute RFC 3339 date-time");
  }
  return parsed.toISOString();
}

export function isRfc3339Instant(value: unknown): value is string {
  try {
    normalizeRfc3339Instant(value);
    return true;
  } catch {
    return false;
  }
}

type CalendarDateParts = {
  year: number;
  month: number;
  day: number;
};

function calendarDateParts(value: string, field: string): CalendarDateParts {
  const match = CALENDAR_DATE.exec(value);
  if (!match) throw new RangeError(`${field} must be YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) {
    throw new RangeError(`${field} must be a valid calendar date`);
  }
  return { year, month, day };
}

function dateOrdinal(parts: CalendarDateParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86_400_000);
}

export function assertIanaTimezone(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new RangeError("timezone must be an IANA timezone");
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    throw new RangeError("timezone must be an IANA timezone");
  }
}

function localDateFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function formattedDateParts(instantMs: number, formatter: Intl.DateTimeFormat): CalendarDateParts {
  const parts = formatter.formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(value("year")),
    month: Number(value("month")),
    day: Number(value("day")),
  };
}

function localDateOrdinalAt(instantMs: number, formatter: Intl.DateTimeFormat): number {
  return dateOrdinal(formattedDateParts(instantMs, formatter));
}

function startOfLocalDate(
  value: string,
  timezone: string,
  field: string,
  formatter: Intl.DateTimeFormat,
): string {
  const target = calendarDateParts(value, field);
  const targetOrdinal = dateOrdinal(target);
  const nominalUtc = Date.UTC(target.year, target.month - 1, target.day);
  let low = nominalUtc - SEARCH_PADDING_MS;
  let high = nominalUtc + SEARCH_PADDING_MS;

  while (localDateOrdinalAt(low, formatter) >= targetOrdinal) low -= SEARCH_PADDING_MS;
  while (localDateOrdinalAt(high, formatter) < targetOrdinal) high += SEARCH_PADDING_MS;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateOrdinalAt(middle, formatter) >= targetOrdinal) high = middle;
    else low = middle + 1;
  }

  if (localDateOrdinalAt(low, formatter) !== targetOrdinal) {
    throw new RangeError(`${field} does not exist in timezone ${timezone}`);
  }
  return new Date(low).toISOString();
}

/**
 * Projects one absolute instant onto a concrete calendar date in an explicit
 * viewing timezone. This is presentation/query semantics only; it does not
 * change the instant or adopt the record's own timezone as viewer context.
 */
export function instantToLocalDate(value: string, timezone: string): string {
  const normalizedTimezone = assertIanaTimezone(timezone);
  const parsed = new Date(normalizeRfc3339Instant(value));
  const parts = formattedDateParts(parsed.getTime(), localDateFormatter(normalizedTimezone));
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Converts a concrete local calendar-date window into one absolute instant range.
 *
 * The input dates use half-open semantics `[dateStart, dateEndExclusive)` in the
 * supplied viewing timezone. Start and end are resolved independently so DST or
 * historical offset changes may produce a range whose duration is not 24 hours
 * per local calendar day. A skipped local date is rejected rather than silently
 * normalized to a neighboring date.
 */
export function localDateWindowToInstantRange(input: LocalDateWindow): InstantRange {
  const timezone = assertIanaTimezone(input.timezone);
  const start = calendarDateParts(input.dateStart, "dateStart");
  const end = calendarDateParts(input.dateEndExclusive, "dateEndExclusive");
  if (dateOrdinal(end) <= dateOrdinal(start)) {
    throw new RangeError("dateEndExclusive must be later than dateStart");
  }
  const formatter = localDateFormatter(timezone);

  return {
    startInclusive: startOfLocalDate(input.dateStart, timezone, "dateStart", formatter),
    endExclusive: startOfLocalDate(input.dateEndExclusive, timezone, "dateEndExclusive", formatter),
  };
}

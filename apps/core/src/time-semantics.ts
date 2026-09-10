const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
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
  if (!value.trim()) throw new RangeError("timezone must be an IANA timezone");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return value;
  } catch {
    throw new RangeError("timezone must be an IANA timezone");
  }
}

function localDateOrdinalAt(instantMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  return dateOrdinal({ year, month, day });
}

function startOfLocalDate(value: string, timezone: string, field: string): string {
  const target = calendarDateParts(value, field);
  const targetOrdinal = dateOrdinal(target);
  const nominalUtc = Date.UTC(target.year, target.month - 1, target.day);
  let low = nominalUtc - SEARCH_PADDING_MS;
  let high = nominalUtc + SEARCH_PADDING_MS;

  while (localDateOrdinalAt(low, timezone) >= targetOrdinal) low -= SEARCH_PADDING_MS;
  while (localDateOrdinalAt(high, timezone) < targetOrdinal) high += SEARCH_PADDING_MS;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localDateOrdinalAt(middle, timezone) >= targetOrdinal) high = middle;
    else low = middle + 1;
  }

  if (localDateOrdinalAt(low, timezone) !== targetOrdinal) {
    throw new RangeError(`${field} does not exist in timezone ${timezone}`);
  }
  return new Date(low).toISOString();
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

  return {
    startInclusive: startOfLocalDate(input.dateStart, timezone, "dateStart"),
    endExclusive: startOfLocalDate(input.dateEndExclusive, timezone, "dateEndExclusive"),
  };
}

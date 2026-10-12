import { ApiError } from "./http";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
type Weekday = typeof WEEKDAYS[number];
export type RecurrenceRule =
  | { mode: "calendar"; frequency: "daily"; interval: number }
  | { mode: "calendar"; frequency: "weekly"; interval: number; weekdays: Weekday[] }
  | { mode: "calendar"; frequency: "monthly"; interval: number; monthDays: number[] }
  | { mode: "calendar"; frequency: "yearly"; interval: number; dates: { month: number; day: number }[] }
  | { mode: "after_completion"; interval: { value: number; unit: "day" | "week" | "month" | "year" } };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function fail(): never { throw new ApiError("INVALID_RECURRENCE_RULE", "Invalid structured recurrence rule", 400); }
function integer(value: unknown, max = 10000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) fail();
  return Number(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function list<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || !value.length || value.length > max) fail();
  const result = value.map(parse);
  if (new Set(result.map(v => JSON.stringify(v))).size !== result.length) fail();
  return result;
}

/** Closed, canonical, date-level domain contract. No executable expressions. */
export function parseRecurrenceRule(value: unknown): RecurrenceRule {
  const raw = object(value);
  if (raw.mode === "after_completion") {
    keys(raw, ["mode", "interval"]);
    const interval = object(raw.interval); keys(interval, ["value", "unit"]);
    if (!["day", "week", "month", "year"].includes(String(interval.unit))) fail();
    return { mode: "after_completion", interval: { value: integer(interval.value), unit: interval.unit as "day" | "week" | "month" | "year" } };
  }
  if (raw.mode !== "calendar") fail();
  const interval = integer(raw.interval);
  switch (raw.frequency) {
    case "daily":
      keys(raw, ["mode", "frequency", "interval"]);
      return { mode: "calendar", frequency: "daily", interval };
    case "weekly": {
      keys(raw, ["mode", "frequency", "interval", "weekdays"]);
      const weekdays = list(raw.weekdays, 7, v => {
        if (!WEEKDAYS.includes(v as Weekday)) fail(); return v as Weekday;
      }).sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
      return { mode: "calendar", frequency: "weekly", interval, weekdays };
    }
    case "monthly":
      keys(raw, ["mode", "frequency", "interval", "monthDays"]);
      return { mode: "calendar", frequency: "monthly", interval, monthDays: list(raw.monthDays, 31, v => integer(v, 31)).sort((a, b) => a - b) };
    case "yearly": {
      keys(raw, ["mode", "frequency", "interval", "dates"]);
      const dates = list(raw.dates, 366, value => {
        const date = object(value); keys(date, ["month", "day"]);
        const month = integer(date.month, 12), day = integer(date.day, 31);
        // Leap-year validation permits Feb 29 but rejects impossible dates.
        if (day > daysInMonth(2000, month)) fail();
        return { month, day };
      }).sort((a, b) => a.month - b.month || a.day - b.day);
      return { mode: "calendar", frequency: "yearly", interval, dates };
    }
    default: return fail();
  }
}

const DAY = 86400000;
function utc(year: number, month: number, day: number): Date {
  const d = new Date(0); d.setUTCFullYear(year, month - 1, day); return d;
}
export function parseRecurrenceDate(value: unknown): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail();
  const [y, m, d] = value.split("-").map(Number);
  const date = utc(y!, m!, d!);
  if (y! < 1 || date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) fail();
  return date;
}
function format(date: Date): string {
  if (date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) fail();
  return date.toISOString().slice(0, 10);
}
function daysInMonth(y: number, m: number): number { return utc(y, m + 1, 0).getUTCDate(); }
function monday(date: Date): number { return date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY; }
export function addRecurrenceInterval(date: string, interval: Extract<RecurrenceRule, { mode: "after_completion" }>["interval"]): string {
  const d = parseRecurrenceDate(date);
  if (interval.unit === "day" || interval.unit === "week") return format(new Date(d.getTime() + interval.value * (interval.unit === "week" ? 7 : 1) * DAY));
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth() + interval.value * (interval.unit === "year" ? 12 : 1);
  const y = Math.floor(months / 12), m = months % 12 + 1;
  return format(utc(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m))));
}
export function addRecurrenceDays(date: string, days: number): string {
  return format(new Date(parseRecurrenceDate(date).getTime() + days * DAY));
}
export function spaceRecurrenceDate(instant: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Jump directly to eligible periods; work is bounded by the requested window. */
export function calendarOccurrences(rule: Extract<RecurrenceRule, { mode: "calendar" }>, first: string, from: string, through: string, limit: number): { dates: string[]; nextDate: string | null } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail();
  const anchor = parseRecurrenceDate(first), lower = parseRecurrenceDate(from > first ? from : first), upper = parseRecurrenceDate(through);
  const dates: string[] = [];
  if (lower > upper) return { dates, nextDate: null };
  const startIndex = rule.frequency === "daily" ? Math.floor((lower.getTime() - anchor.getTime()) / DAY)
    : rule.frequency === "weekly" ? Math.floor((monday(lower) - monday(anchor)) / (7 * DAY))
    : rule.frequency === "monthly" ? (lower.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + lower.getUTCMonth() - anchor.getUTCMonth()
    : lower.getUTCFullYear() - anchor.getUTCFullYear();
  const period = (index: number): Date => rule.frequency === "daily" ? new Date(anchor.getTime() + index * DAY)
    : rule.frequency === "weekly" ? new Date(monday(anchor) + index * 7 * DAY)
    : rule.frequency === "monthly" ? utc(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1 + index, 1)
    : utc(anchor.getUTCFullYear() + index, 1, 1);
  for (let index = Math.floor(startIndex / rule.interval) * rule.interval; ; index += rule.interval) {
    const base = period(index);
    if (base > upper || base.getUTCFullYear() > 9999) break;
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1;
    const candidates = rule.frequency === "daily" ? [base]
      : rule.frequency === "weekly" ? rule.weekdays.map(day => new Date(base.getTime() + WEEKDAYS.indexOf(day) * DAY))
      : rule.frequency === "monthly" ? rule.monthDays.filter(day => day <= daysInMonth(y, m)).map(day => utc(y, m, day))
      : rule.dates.filter(date => date.day <= daysInMonth(y, date.month)).map(date => utc(y, date.month, date.day));
    for (const candidate of candidates) {
      if (candidate < lower || candidate > upper) continue;
      const date = format(candidate);
      if (dates.length === limit) return { dates, nextDate: date };
      dates.push(date);
    }
  }
  return { dates, nextDate: null };
}

export function recurrenceRuleSchema(): Record<string, unknown> {
  const positive = { type: "integer", minimum: 1, maximum: 10000 };
  const variant = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
  const calendar = (frequency: string, extra = {}) => variant({ mode: { const: "calendar" }, frequency: { const: frequency }, interval: positive, ...extra });
  const array = (items: unknown, maxItems: number) => ({ type: "array", minItems: 1, maxItems, uniqueItems: true, items });
  return { oneOf: [calendar("daily"), calendar("weekly", { weekdays: array({ enum: WEEKDAYS }, 7) }), calendar("monthly", { monthDays: array({ type: "integer", minimum: 1, maximum: 31 }, 31) }),
    calendar("yearly", { dates: array({ oneOf: Array.from({ length: 12 }, (_, index) => variant({ month: { const: index + 1 }, day: { type: "integer", minimum: 1, maximum: daysInMonth(2000, index + 1) } })) }, 366) }),
    variant({ mode: { const: "after_completion" }, interval: variant({ value: positive, unit: { enum: ["day", "week", "month", "year"] } }) })],
    "x-lifespace-type": "recurrence_rule", "x-lifespace-invalid-calendar-date": "skip", "x-lifespace-phase": "firstDueDate calendar period; week starts Monday" };
}

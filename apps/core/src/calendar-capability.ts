import type { CalendarCapabilityDefinition } from "./capability-definition";
import type { Bindings, Principal } from "./env";
import { createGenericResource, getGenericResource, updateGenericResource, type GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_CALENDAR_RESOURCE", "Calendar resource input must be an object", 400);
  return value as JsonObject;
}

function config(model: PublishedModel): CalendarCapabilityDefinition {
  const calendar = model.definition.capabilities?.calendar;
  if (!calendar) throw new ApiError("CALENDAR_CAPABILITY_NOT_ENABLED", `Model ${model.key} does not enable Calendar capability`, 404);
  return calendar;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ApiError("INVALID_CALENDAR_DATE", `${field} must be YYYY-MM-DD`, 400);
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) throw new ApiError("INVALID_CALENDAR_DATE", `${field} must be a valid date`, 400);
  return value;
}

function instant(value: unknown, field: string): string {
  if (typeof value !== "string" || !/T/u.test(value)) throw new ApiError("INVALID_CALENDAR_INSTANT", `${field} must be an RFC 3339 date-time`, 400);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new ApiError("INVALID_CALENDAR_INSTANT", `${field} must be an RFC 3339 date-time`, 400);
  return parsed.toISOString();
}

function timezone(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new ApiError("INVALID_CALENDAR_TIMEZONE", `${field} must be an IANA timezone`, 400);
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); }
  catch { throw new ApiError("INVALID_CALENDAR_TIMEZONE", `${field} must be an IANA timezone`, 400); }
  return value;
}

function required(value: unknown, field: string): unknown {
  if (value === undefined || value === null || value === "") throw new ApiError("INVALID_CALENDAR_RESOURCE", `${field} is required for this Calendar mode`, 400);
  return value;
}

function reject(data: JsonObject, fields: string[], message: string): void {
  if (fields.some((field) => data[field] !== undefined && data[field] !== null && data[field] !== "")) throw new ApiError("INVALID_CALENDAR_RESOURCE", message, 400);
}

function normalize(model: PublishedModel, candidate: JsonObject): JsonObject {
  const calendar = config(model);
  const allDay = candidate[calendar.allDayField];
  if (typeof allDay !== "boolean") throw new ApiError("INVALID_CALENDAR_RESOURCE", `${calendar.allDayField} must be boolean`, 400);
  const normalized = { ...candidate };
  if (allDay) {
    reject(candidate, [calendar.timedStartField, calendar.timedEndField, calendar.startTimezoneField, calendar.endTimezoneField], "All-day Calendar resources cannot contain timed instants or timezones");
    const start = exactDate(required(candidate[calendar.allDayStartField], calendar.allDayStartField), calendar.allDayStartField);
    const end = exactDate(required(candidate[calendar.allDayEndExclusiveField], calendar.allDayEndExclusiveField), calendar.allDayEndExclusiveField);
    if (end <= start) throw new ApiError("INVALID_CALENDAR_RANGE", `${calendar.allDayEndExclusiveField} must be later than ${calendar.allDayStartField}`, 400);
    normalized[calendar.allDayStartField] = start;
    normalized[calendar.allDayEndExclusiveField] = end;
    normalized[calendar.timedStartField] = null;
    normalized[calendar.timedEndField] = null;
    normalized[calendar.startTimezoneField] = null;
    normalized[calendar.endTimezoneField] = null;
    return normalized;
  }
  reject(candidate, [calendar.allDayStartField, calendar.allDayEndExclusiveField], "Timed Calendar resources cannot contain all-day dates");
  const start = instant(required(candidate[calendar.timedStartField], calendar.timedStartField), calendar.timedStartField);
  const end = instant(required(candidate[calendar.timedEndField], calendar.timedEndField), calendar.timedEndField);
  if (end <= start) throw new ApiError("INVALID_CALENDAR_RANGE", `${calendar.timedEndField} must be later than ${calendar.timedStartField}`, 400);
  normalized[calendar.timedStartField] = start;
  normalized[calendar.timedEndField] = end;
  normalized[calendar.startTimezoneField] = timezone(required(candidate[calendar.startTimezoneField], calendar.startTimezoneField), calendar.startTimezoneField);
  normalized[calendar.endTimezoneField] = timezone(required(candidate[calendar.endTimezoneField], calendar.endTimezoneField), calendar.endTimezoneField);
  normalized[calendar.allDayStartField] = null;
  normalized[calendar.allDayEndExclusiveField] = null;
  return normalized;
}

export function prepareCalendarCreate(model: PublishedModel, input: unknown): JsonObject {
  const value = object(input);
  const calendar = config(model);
  return normalize(model, {
    ...value,
    [calendar.timedStartField]: value[calendar.timedStartField] ?? null,
    [calendar.timedEndField]: value[calendar.timedEndField] ?? null,
    [calendar.startTimezoneField]: value[calendar.startTimezoneField] ?? null,
    [calendar.endTimezoneField]: value[calendar.endTimezoneField] ?? null,
    [calendar.allDayStartField]: value[calendar.allDayStartField] ?? null,
    [calendar.allDayEndExclusiveField]: value[calendar.allDayEndExclusiveField] ?? null,
  });
}

export function prepareCalendarUpdate(model: PublishedModel, resource: GenericResource, input: unknown): JsonObject {
  const calendar = config(model);
  const patch = object(input);
  const candidate: JsonObject = { ...resource.data, ...patch };
  const currentAllDay = resource.data[calendar.allDayField];
  const requestedAllDay = patch[calendar.allDayField];

  // A Calendar mode switch is one semantic update. Clear only opposite-mode values
  // inherited from the stored record; explicitly supplied conflicting values still
  // flow into normalize() and are rejected as malformed input.
  if (currentAllDay === true && requestedAllDay === false) {
    if (patch[calendar.allDayStartField] === undefined) candidate[calendar.allDayStartField] = null;
    if (patch[calendar.allDayEndExclusiveField] === undefined) candidate[calendar.allDayEndExclusiveField] = null;
  } else if (currentAllDay === false && requestedAllDay === true) {
    if (patch[calendar.timedStartField] === undefined) candidate[calendar.timedStartField] = null;
    if (patch[calendar.timedEndField] === undefined) candidate[calendar.timedEndField] = null;
    if (patch[calendar.startTimezoneField] === undefined) candidate[calendar.startTimezoneField] = null;
    if (patch[calendar.endTimezoneField] === undefined) candidate[calendar.endTimezoneField] = null;
  }

  const normalized = normalize(model, candidate);
  const changes: JsonObject = {};
  for (const [key, value] of Object.entries(normalized)) if (resource.data[key] !== value) changes[key] = value;
  if (!Object.keys(changes).length) throw new ApiError("INVALID_REQUEST", "Calendar update does not change any field", 400);
  return changes;
}

export async function createCalendarResource(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, input: unknown) {
  return createGenericResource(env, principal, spaceId, model, prepareCalendarCreate(model, input));
}

export async function updateCalendarResource(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, recordId: string, expectedVersion: number, input: unknown) {
  const resource = await getGenericResource(env, spaceId, model.key, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  return updateGenericResource(env, principal, spaceId, model, recordId, expectedVersion, prepareCalendarUpdate(model, resource, input));
}

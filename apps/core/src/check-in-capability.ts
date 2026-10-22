import { daysBetween, spaceToday } from "./day-calculation";
import type { CheckInCapabilityDefinition } from "./capability-definition";
import type { Bindings, Principal } from "./env";
import { getGenericResource, updateGenericResource, type GenericResource, type MutationAttribution, type ResourceMutationExtension } from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import { loadSpaceTemporalContext } from "./temporal-capability";

type HistoryRow = {
  id: string; record_id: string; checked_on: string;
  recorded_by_type: Principal["type"]; recorded_by_id: string;
  recorded_by_name_snapshot: string; created_at: string;
};
export type CheckInEntry = {
  id: string; recordId: string; checkedOn: string;
  recordedBy: { type: Principal["type"]; id: string; displayName: string };
  createdAt: string;
};
export type CheckInComputed = { today: string; streakDays: number; checkedInToday: boolean };

function config(model: PublishedModel): CheckInCapabilityDefinition {
  const result = model.definition.capabilities?.checkIn;
  if (!result) throw new ApiError("CHECK_IN_NOT_ALLOWED", "Model does not support check-in", 404);
  return result;
}
function interval(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ApiError("INVALID_CHECK_IN_INTERVAL", "Check-in interval must be a positive integer", 400);
  return Number(value);
}
function assertCheckInActive(data: Record<string, unknown>, c: CheckInCapabilityDefinition): void {
  if (c.statusField && !c.allowedStatuses?.includes(data[c.statusField] as string)) {
    throw new ApiError("CHECK_IN_INACTIVE", "Check-in is unavailable for the current lifecycle state", 409);
  }
}
function state(data: Record<string, unknown>, c: CheckInCapabilityDefinition) {
  const last = data[c.lastCheckInDateField];
  const start = data[c.streakStartDateField];
  if (last === null || last === undefined) {
    if (start !== null && start !== undefined) throw new ApiError("CHECK_IN_STATE_CORRUPT", "Check-in start without last date", 500);
    return { last: null, start: null };
  }
  if (typeof last !== "string" || typeof start !== "string" || start > last) {
    throw new ApiError("CHECK_IN_STATE_CORRUPT", "Invalid check-in state", 500);
  }
  return { last, start };
}
export function prepareCheckInCreate(model: PublishedModel, raw: unknown): Record<string, unknown> {
  const c = config(model);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("INVALID_RESOURCE", "Expected an object", 400);
  const input = raw as Record<string, unknown>;
  if (c.lastCheckInDateField in input || c.streakStartDateField in input) throw new ApiError("INVALID_RESOURCE", "Check-in state is managed by Core", 400);
  return { ...input, [c.lastCheckInDateField]: null, [c.streakStartDateField]: null };
}
export function computeCheckIn(model: PublishedModel, resource: GenericResource, timezone: string): CheckInComputed {
  const c = config(model);
  const today = spaceToday(timezone);
  const maximumGap = interval(resource.data[c.intervalDaysField]);
  const { last, start } = state(resource.data, c);
  const age = last ? daysBetween(last, today) : Infinity;
  return {
    today,
    streakDays: last && start && age >= 0 && age <= maximumGap ? daysBetween(start, last) + 1 : 0,
    checkedInToday: last === today,
  };
}
function historyExtension(date: string): ResourceMutationExtension {
  return ({ env, principal, recordId, timestamp, mutationToken }) => {
    if (!mutationToken) throw new ApiError("CHECK_IN_UNGUARDED", "Check-in requires atomic mutation guard", 500);
    return [env.DB.prepare(
      "INSERT INTO check_in_occurrences(id,record_id,checked_on,recorded_by_type,recorded_by_id,recorded_by_name_snapshot,created_at) "
      + "SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=? AND deleted_at IS NULL)",
    ).bind("cki_" + crypto.randomUUID().replaceAll("-", ""), recordId, date,
      principal.type, principal.id, principal.displayName?.trim() || principal.id, timestamp, recordId, mutationToken)];
  };
}
export async function recordCheckIn(
  env: Bindings, principal: Principal, spaceId: string, model: PublishedModel,
  recordId: string, version: number, attribution: MutationAttribution = {},
): Promise<GenericResource> {
  const c = config(model);
  const space = await loadSpaceTemporalContext(env, spaceId);
  const today = spaceToday(space.timezone);
  const resource = await getGenericResource(env, spaceId, model, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Record not found", 404);
  assertCheckInActive(resource.data, c);
  const previous = state(resource.data, c);
  if (previous.last === today) return resource; // Repeated same-day check-in has no side effects.
  if (previous.last && previous.last > today) throw new ApiError("INVALID_CHECK_IN_DATE", "Previous date is later than the Space current date", 409);
  if (resource.version !== version) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  const continued = previous.last !== null && daysBetween(previous.last, today) <= interval(resource.data[c.intervalDaysField]);
  try {
    return await updateGenericResource(
      env, principal, spaceId, model, recordId, version,
      { [c.lastCheckInDateField]: today, [c.streakStartDateField]: continued ? previous.start : today },
      "action", historyExtension(today), resource, "check-in", attribution,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
      const newer = await getGenericResource(env, spaceId, model, recordId);
      if (newer?.data[c.lastCheckInDateField] === today) {
        assertCheckInActive(newer.data, c);
        return newer;
      }
    }
    throw error;
  }
}
type HistoryCursor = { v: 1; recordId: string; date: string; id: string };
function encode(cursor: HistoryCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decode(value: string, recordId: string): HistoryCursor {
  try {
    const c = JSON.parse(atob(value.replaceAll("-", "+").replaceAll("_", "/"))) as HistoryCursor;
    if (c.v !== 1 || c.recordId !== recordId || !/^\d{4}-\d{2}-\d{2}$/u.test(c.date) || !/^cki_[a-f0-9]{32}$/u.test(c.id)) throw new Error();
    return c;
  } catch {
    throw new ApiError("INVALID_QUERY", "Invalid check-in history cursor", 400);
  }
}
export async function listCheckIns(
  env: Bindings, spaceId: string, model: PublishedModel, recordId: string, limit: number, cursor?: string,
): Promise<{ items: CheckInEntry[]; nextCursor: string | null }> {
  config(model);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("INVALID_QUERY", "Invalid limit", 400);
  const resource = await getGenericResource(env, spaceId, model, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Record not found", 404);
  const previous = cursor ? decode(cursor, recordId) : null;
  const sql = "SELECT * FROM check_in_occurrences WHERE record_id=?"
    + (previous ? " AND (checked_on<? OR (checked_on=? AND id<?))" : "")
    + " ORDER BY checked_on DESC,id DESC LIMIT ?";
  const values = previous
    ? [recordId, previous.date, previous.date, previous.id, limit + 1]
    : [recordId, limit + 1];
  const records = await env.DB.prepare(sql).bind(...values).all<HistoryRow>();
  const page = records.results.slice(0, limit), last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id, recordId: r.record_id, checkedOn: r.checked_on,
      recordedBy: { type: r.recorded_by_type, id: r.recorded_by_id, displayName: r.recorded_by_name_snapshot },
      createdAt: r.created_at,
    })),
    nextCursor: records.results.length > limit && last
      ? encode({ v: 1, recordId, date: last.checked_on, id: last.id }) : null,
  };
}

import type { TemporalCapabilityDefinition } from "./capability-definition";
import { addDateDays, computeDayRecord, daysBetween, spaceToday, type DayRecordKind } from "./day-calculation";
import type { Bindings, Principal } from "./env";
import {
  createGenericResource,
  getGenericResource,
  updateGenericResource,
  type GenericResource,
  type ResourceMutationExtension,
} from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";

type JsonObject = Record<string, unknown>;

type SpaceTemporalContext = {
  id: string;
  timezone: string;
};

type TemporalOccurrenceRow = {
  id: string;
  record_id: string;
  occurred_on: string;
  note: string | null;
  source: "initial" | "manual";
  recorded_by_type: Principal["type"];
  recorded_by_id: string;
  recorded_by_name_snapshot: string;
  created_at: string;
  interval_days: number | null;
};

type OccurrenceCursor = {
  v: 1;
  recordId: string;
  occurredOn: string;
  id: string;
};

export type TemporalComputed = ReturnType<typeof computeTemporal> & {
  nextDueDate?: string;
};

export type TemporalOccurrence = {
  id: string;
  recordId: string;
  occurredOn: string;
  note: string | null;
  source: "initial" | "manual";
  intervalDays: number | null;
  recordedBy: {
    type: Principal["type"];
    id: string;
    displayName: string;
  };
  createdAt: string;
};

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_TEMPORAL_RESOURCE", "Temporal resource input must be an object", 400);
  return value as JsonObject;
}

function config(model: PublishedModel): TemporalCapabilityDefinition {
  const temporal = model.definition.capabilities?.temporal;
  if (!temporal) throw new ApiError("TEMPORAL_CAPABILITY_NOT_ENABLED", `Model ${model.key} does not enable Temporal capability`, 404);
  return temporal;
}

function exactDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ApiError("INVALID_TEMPORAL_DATE", `${field} must be YYYY-MM-DD`, 400);
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) {
    throw new ApiError("INVALID_TEMPORAL_DATE", `${field} must be a valid date`, 400);
  }
  return value;
}

function integerOrNull(value: unknown, field: string, minimum: number): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || Number(value) < minimum) throw new ApiError("INVALID_TEMPORAL_RULE", `${field} must be null or an integer >= ${minimum}`, 400);
  return Number(value);
}

function kind(data: JsonObject, temporal: TemporalCapabilityDefinition): DayRecordKind {
  const value = data[temporal.kindField];
  if (value !== "elapsed" && value !== "countdown" && value !== "cycle") throw new ApiError("INVALID_TEMPORAL_KIND", "Temporal kind must be elapsed, countdown, or cycle", 400);
  return value;
}

function status(data: JsonObject, temporal: TemporalCapabilityDefinition): "active" | "archived" {
  const value = data[temporal.statusField];
  if (value !== "active" && value !== "archived") throw new ApiError("INVALID_TEMPORAL_STATUS", "Temporal status must be active or archived", 500);
  return value;
}

function temporalFieldSet(temporal: TemporalCapabilityDefinition): Set<string> {
  return new Set([
    temporal.kindField,
    temporal.anchorDateField,
    temporal.cycleDaysField,
    temporal.attentionBeforeDaysField,
    temporal.attentionAfterDaysField,
    temporal.statusField,
  ]);
}

function rejectTemporalFields(input: JsonObject, fields: string[], message: string): void {
  const supplied = fields.find((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (supplied) throw new ApiError("INVALID_TEMPORAL_RULE", message, 400);
}

export async function loadSpaceTemporalContext(env: Bindings, spaceId: string): Promise<SpaceTemporalContext> {
  const row = await env.DB.prepare("SELECT id,timezone FROM spaces WHERE id=? AND deleted_at IS NULL")
    .bind(spaceId).first<{ id: string; timezone: string }>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  return { id: row.id, timezone: row.timezone };
}

export function prepareTemporalCreate(
  model: PublishedModel,
  inputValue: unknown,
  space: SpaceTemporalContext,
): JsonObject {
  const temporal = config(model);
  const input = object(inputValue);
  if (Object.prototype.hasOwnProperty.call(input, temporal.statusField)) {
    throw new ApiError("INVALID_TEMPORAL_RULE", `${temporal.statusField} is managed by Temporal capability`, 400);
  }
  const recordKind = kind(input, temporal);
  const anchorDate = exactDate(input[temporal.anchorDateField], temporal.anchorDateField);
  const today = spaceToday(space.timezone);
  if (recordKind !== "countdown" && anchorDate > today) {
    throw new ApiError("INVALID_TEMPORAL_DATE", `${temporal.anchorDateField} cannot be later than the Space current date`, 400);
  }

  const prepared: JsonObject = {
    ...input,
    [temporal.statusField]: "active",
    [temporal.cycleDaysField]: null,
    [temporal.attentionBeforeDaysField]: null,
    [temporal.attentionAfterDaysField]: null,
  };

  if (recordKind === "elapsed") {
    rejectTemporalFields(input, [temporal.cycleDaysField, temporal.attentionBeforeDaysField], "Elapsed temporal resources do not accept cycleDays or attentionBeforeDays");
    prepared[temporal.attentionAfterDaysField] = input[temporal.attentionAfterDaysField] === undefined
      ? null
      : integerOrNull(input[temporal.attentionAfterDaysField], temporal.attentionAfterDaysField, 1);
  } else if (recordKind === "countdown") {
    rejectTemporalFields(input, [temporal.cycleDaysField, temporal.attentionAfterDaysField], "Countdown temporal resources do not accept cycleDays or attentionAfterDays");
    prepared[temporal.attentionBeforeDaysField] = input[temporal.attentionBeforeDaysField] === undefined
      ? 30
      : integerOrNull(input[temporal.attentionBeforeDaysField], temporal.attentionBeforeDaysField, 0);
  } else {
    rejectTemporalFields(input, [temporal.attentionAfterDaysField], "Cycle temporal resources do not accept attentionAfterDays");
    const cycleDays = integerOrNull(input[temporal.cycleDaysField], temporal.cycleDaysField, 1);
    if (cycleDays === null) throw new ApiError("INVALID_TEMPORAL_RULE", `${temporal.cycleDaysField} is required for cycle resources`, 400);
    prepared[temporal.cycleDaysField] = cycleDays;
    prepared[temporal.attentionBeforeDaysField] = input[temporal.attentionBeforeDaysField] === undefined
      ? 7
      : integerOrNull(input[temporal.attentionBeforeDaysField], temporal.attentionBeforeDaysField, 0);
  }
  return prepared;
}

export function prepareTemporalUpdate(
  model: PublishedModel,
  resource: GenericResource,
  inputValue: unknown,
): JsonObject {
  const temporal = config(model);
  const input = object(inputValue);
  if (status(resource.data, temporal) === "archived") throw new ApiError("TEMPORAL_RESOURCE_ARCHIVED", "Archived temporal resources are read-only", 409);
  if (Object.prototype.hasOwnProperty.call(input, temporal.kindField) || Object.prototype.hasOwnProperty.call(input, temporal.statusField)) {
    throw new ApiError("INVALID_TEMPORAL_RULE", "Temporal kind/status cannot be changed by ordinary update", 400);
  }

  const recordKind = kind(resource.data, temporal);
  if (recordKind === "elapsed") {
    rejectTemporalFields(input, [temporal.anchorDateField, temporal.cycleDaysField, temporal.attentionBeforeDaysField], "Elapsed update may not change anchorDate, cycleDays, or attentionBeforeDays");
    if (Object.prototype.hasOwnProperty.call(input, temporal.attentionAfterDaysField)) {
      input[temporal.attentionAfterDaysField] = integerOrNull(input[temporal.attentionAfterDaysField], temporal.attentionAfterDaysField, 1);
    }
  } else if (recordKind === "countdown") {
    rejectTemporalFields(input, [temporal.cycleDaysField, temporal.attentionAfterDaysField], "Countdown update may not change cycleDays or attentionAfterDays");
    if (Object.prototype.hasOwnProperty.call(input, temporal.anchorDateField)) exactDate(input[temporal.anchorDateField], temporal.anchorDateField);
    if (Object.prototype.hasOwnProperty.call(input, temporal.attentionBeforeDaysField)) {
      input[temporal.attentionBeforeDaysField] = integerOrNull(input[temporal.attentionBeforeDaysField], temporal.attentionBeforeDaysField, 0);
    }
  } else {
    rejectTemporalFields(input, [temporal.anchorDateField, temporal.attentionAfterDaysField], "Cycle update may not change anchorDate or attentionAfterDays");
    if (Object.prototype.hasOwnProperty.call(input, temporal.cycleDaysField)) {
      const cycleDays = integerOrNull(input[temporal.cycleDaysField], temporal.cycleDaysField, 1);
      if (cycleDays === null) throw new ApiError("INVALID_TEMPORAL_RULE", `${temporal.cycleDaysField} cannot be null for cycle resources`, 400);
      input[temporal.cycleDaysField] = cycleDays;
    }
    if (Object.prototype.hasOwnProperty.call(input, temporal.attentionBeforeDaysField)) {
      input[temporal.attentionBeforeDaysField] = integerOrNull(input[temporal.attentionBeforeDaysField], temporal.attentionBeforeDaysField, 0);
    }
  }
  return input;
}

function temporalInput(model: PublishedModel, data: JsonObject) {
  const temporal = config(model);
  const recordKind = kind(data, temporal);
  const anchorDate = exactDate(data[temporal.anchorDateField], temporal.anchorDateField);
  if (recordKind === "elapsed") {
    return {
      kind: recordKind,
      anchorDate,
      attentionAfterDays: data[temporal.attentionAfterDaysField] === null ? null : Number(data[temporal.attentionAfterDaysField]),
    } as const;
  }
  if (recordKind === "countdown") {
    return {
      kind: recordKind,
      anchorDate,
      attentionBeforeDays: data[temporal.attentionBeforeDaysField] === null ? null : Number(data[temporal.attentionBeforeDaysField]),
    } as const;
  }
  const cycleDays = Number(data[temporal.cycleDaysField]);
  if (!Number.isInteger(cycleDays) || cycleDays < 1) throw new ApiError("TEMPORAL_STORAGE_CORRUPT", "Cycle resource is missing a valid cycleDays", 500);
  return {
    kind: recordKind,
    anchorDate,
    cycleDays,
    nextDueDate: addDateDays(anchorDate, cycleDays),
    attentionBeforeDays: data[temporal.attentionBeforeDaysField] === null ? null : Number(data[temporal.attentionBeforeDaysField]),
  } as const;
}

function computeTemporal(model: PublishedModel, data: JsonObject, today: string) {
  const input = temporalInput(model, data);
  return computeDayRecord(input as Parameters<typeof computeDayRecord>[0], today);
}

export function computeTemporalResource(
  model: PublishedModel,
  resource: GenericResource,
  space: SpaceTemporalContext,
): TemporalComputed {
  const input = temporalInput(model, resource.data);
  const computed = computeDayRecord(input as Parameters<typeof computeDayRecord>[0], spaceToday(space.timezone));
  return input.kind === "cycle" ? { ...computed, nextDueDate: input.nextDueDate } : computed;
}

function occurrenceId(): string {
  return `tmo_${crypto.randomUUID().replaceAll("-", "")}`;
}

function initialOccurrenceExtension(anchorDate: string): ResourceMutationExtension {
  return ({ env, principal, recordId, timestamp }) => [
    env.DB.prepare(`INSERT INTO temporal_occurrences(
      id,record_id,occurred_on,note,source,recorded_by_type,recorded_by_id,recorded_by_name_snapshot,created_at
    ) VALUES(?,?,?,NULL,'initial',?,?,?,?)`).bind(
      occurrenceId(),
      recordId,
      anchorDate,
      principal.type,
      principal.id,
      principal.id,
      timestamp,
    ),
  ];
}

export async function createTemporalResource(
  env: Bindings,
  principal: Principal,
  space: SpaceTemporalContext,
  model: PublishedModel,
  input: unknown,
): Promise<GenericResource> {
  const temporal = config(model);
  const prepared = prepareTemporalCreate(model, input, space);
  const recordKind = kind(prepared, temporal);
  const anchorDate = prepared[temporal.anchorDateField] as string;
  return createGenericResource(
    env,
    principal,
    space.id,
    model,
    prepared,
    true,
    temporal.occurrences && recordKind !== "countdown" ? initialOccurrenceExtension(anchorDate) : undefined,
  );
}

export async function updateTemporalResource(
  env: Bindings,
  principal: Principal,
  space: SpaceTemporalContext,
  model: PublishedModel,
  recordId: string,
  expectedVersion: number,
  input: unknown,
): Promise<GenericResource> {
  const resource = await getGenericResource(env, space.id, model.key, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  const prepared = prepareTemporalUpdate(model, resource, input);
  return updateGenericResource(env, principal, space.id, model, recordId, expectedVersion, prepared);
}

function manualOccurrenceExtension(
  occurredOn: string,
  note: string | null,
): ResourceMutationExtension {
  const id = occurrenceId();
  return ({ env, principal, recordId, timestamp, mutationToken }) => {
    if (!mutationToken) throw new ApiError("TEMPORAL_MUTATION_INCONSISTENT", "Manual occurrence requires a guarded resource mutation", 500);
    return [env.DB.prepare(`INSERT INTO temporal_occurrences(
      id,record_id,occurred_on,note,source,recorded_by_type,recorded_by_id,recorded_by_name_snapshot,created_at
    ) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
      SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?
    )`).bind(
      id,
      recordId,
      occurredOn,
      note,
      "manual",
      principal.type,
      principal.id,
      principal.id,
      timestamp,
      recordId,
      mutationToken,
    )];
  };
}

export async function recordTemporalOccurrence(
  env: Bindings,
  principal: Principal,
  space: SpaceTemporalContext,
  model: PublishedModel,
  recordId: string,
  expectedVersion: number,
  occurredOnValue: unknown,
  noteValue: unknown,
): Promise<{ previousAnchorDate: string; intervalDays: number; record: GenericResource }> {
  const temporal = config(model);
  if (temporal.occurrences !== true) throw new ApiError("OCCURRENCE_NOT_ALLOWED", "This Temporal model does not enable occurrences", 409);
  const resource = await getGenericResource(env, space.id, model.key, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (resource.version !== expectedVersion) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
  if (status(resource.data, temporal) === "archived") throw new ApiError("TEMPORAL_RESOURCE_ARCHIVED", "Archived temporal resources do not accept occurrences", 409);
  const recordKind = kind(resource.data, temporal);
  if (recordKind === "countdown") throw new ApiError("OCCURRENCE_NOT_ALLOWED", "Countdown temporal resources do not accept occurrences", 409);

  const occurredOn = exactDate(occurredOnValue, "occurredOn");
  const previousAnchorDate = exactDate(resource.data[temporal.anchorDateField], temporal.anchorDateField);
  const today = spaceToday(space.timezone);
  if (occurredOn === previousAnchorDate) throw new ApiError("DUPLICATE_TEMPORAL_OCCURRENCE", "An occurrence already exists on this date", 409);
  if (occurredOn < previousAnchorDate || occurredOn > today) {
    throw new ApiError("INVALID_TEMPORAL_DATE", "occurredOn must be after the current anchorDate and no later than today", 400);
  }
  let note: string | null = null;
  if (noteValue !== undefined && noteValue !== null) {
    if (typeof noteValue !== "string" || noteValue.length > 1000) throw new ApiError("INVALID_TEMPORAL_OCCURRENCE", "note must be a string up to 1000 characters or null", 400);
    note = noteValue.trim() || null;
  }

  try {
    const record = await updateGenericResource(
      env,
      principal,
      space.id,
      model,
      recordId,
      expectedVersion,
      { [temporal.anchorDateField]: occurredOn },
      "action",
      manualOccurrenceExtension(occurredOn, note),
    );
    return { previousAnchorDate, intervalDays: daysBetween(previousAnchorDate, occurredOn), record };
  } catch (error) {
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
      const current = await getGenericResource(env, space.id, model.key, recordId);
      const currentAnchor = current?.data[temporal.anchorDateField];
      if (currentAnchor === occurredOn) throw new ApiError("DUPLICATE_TEMPORAL_OCCURRENCE", "An occurrence already exists on this date", 409);
      if (typeof currentAnchor === "string" && currentAnchor > occurredOn) throw new ApiError("INVALID_TEMPORAL_DATE", "occurredOn must be after the current anchorDate", 400);
    }
    throw error;
  }
}

function encodeCursor(cursor: OccurrenceCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(raw: string, recordId: string): OccurrenceCursor {
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<OccurrenceCursor>;
    if (value.v !== 1 || value.recordId !== recordId || typeof value.occurredOn !== "string" || typeof value.id !== "string") throw new Error();
    return value as OccurrenceCursor;
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid for this occurrence history", 400);
  }
}

function occurrenceDto(row: TemporalOccurrenceRow): TemporalOccurrence {
  return {
    id: row.id,
    recordId: row.record_id,
    occurredOn: row.occurred_on,
    note: row.note,
    source: row.source,
    intervalDays: row.interval_days,
    recordedBy: { type: row.recorded_by_type, id: row.recorded_by_id, displayName: row.recorded_by_name_snapshot },
    createdAt: row.created_at,
  };
}

export async function listTemporalOccurrences(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  limit = 100,
  cursorValue?: string,
): Promise<{ items: TemporalOccurrence[]; nextCursor: string | null }> {
  const temporal = config(model);
  if (temporal.occurrences !== true) throw new ApiError("OCCURRENCE_NOT_ALLOWED", "This Temporal model does not enable occurrences", 409);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("INVALID_QUERY", "limit must be between 1 and 200", 400);
  const resource = await getGenericResource(env, spaceId, model.key, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  const cursor = cursorValue ? decodeCursor(cursorValue, recordId) : undefined;
  const args: unknown[] = [recordId];
  let where = "";
  if (cursor) {
    where = "WHERE occurred_on<? OR (occurred_on=? AND id<?)";
    args.push(cursor.occurredOn, cursor.occurredOn, cursor.id);
  }
  args.push(limit + 1);
  const rows = await env.DB.prepare(`WITH history AS (
      SELECT o.*,LAG(occurred_on) OVER (ORDER BY occurred_on,id) previous_on
      FROM temporal_occurrences o WHERE record_id=?
    ), enriched AS (
      SELECT *,CASE WHEN previous_on IS NULL THEN NULL ELSE CAST(julianday(occurred_on)-julianday(previous_on) AS INTEGER) END interval_days
      FROM history
    )
    SELECT * FROM enriched ${where} ORDER BY occurred_on DESC,id DESC LIMIT ?`)
    .bind(...args).all<TemporalOccurrenceRow>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(occurrenceDto),
    nextCursor: rows.results.length > limit && last
      ? encodeCursor({ v: 1, recordId, occurredOn: last.occurred_on, id: last.id })
      : null,
  };
}

export function temporalControlFields(model: PublishedModel): Set<string> {
  return temporalFieldSet(config(model));
}

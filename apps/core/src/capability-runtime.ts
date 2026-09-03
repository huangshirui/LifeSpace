import { createCalendarResource, prepareCalendarUpdate } from "./calendar-capability";
import type { Bindings, Principal } from "./env";
import { createGenericResource, getGenericResource, updateGenericResource, type GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import { applyModelDefaults } from "./model-defaults";
import type { PublishedModel } from "./model-registry";
import {
  computeTemporalResource,
  createTemporalResource,
  listTemporalOccurrences,
  loadSpaceTemporalContext,
  prepareTemporalUpdate,
  recordTemporalOccurrence,
  type TemporalOccurrence,
} from "./temporal-capability";

export type CapabilityResponseDecoration = { computed?: { temporal?: ReturnType<typeof computeTemporalResource> } };
export type CapabilityOccurrenceList = { items: TemporalOccurrence[]; nextCursor: string | null };

export function hasTemporalCapability(model: PublishedModel) { return Boolean(model.definition.capabilities?.temporal); }
export function hasCalendarCapability(model: PublishedModel) { return Boolean(model.definition.capabilities?.calendar); }

export function prepareCapabilityCreateInput(model: PublishedModel, input: unknown): Record<string, unknown> {
  return applyModelDefaults(model.definition, input);
}

function rejectClientReadOnlyCreateFields(model: PublishedModel, input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const readOnlyField = Object.keys(input as Record<string, unknown>)
    .find((key) => model.definition.fields[key]?.readOnly === true);
  if (readOnlyField) throw new ApiError("INVALID_RESOURCE", `Field ${readOnlyField} is read-only`, 400);
}

export async function createCapabilityAwareResource(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, input: unknown): Promise<GenericResource> {
  // Capability preparation may derive trusted read-only values. Preserve the
  // original client authority boundary before any defaults or capability-owned
  // fields are added so trusted preparation cannot turn a client-supplied
  // read-only field into an authorized internal mutation.
  rejectClientReadOnlyCreateFields(model, input);
  if (hasTemporalCapability(model)) {
    const space = await loadSpaceTemporalContext(env, spaceId);
    return createTemporalResource(env, principal, space, model, input);
  }
  if (hasCalendarCapability(model)) {
    return createCalendarResource(env, principal, spaceId, model, input);
  }
  return createGenericResource(env, principal, spaceId, model, input);
}

export async function updateCapabilityAwareResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  expectedVersion: number,
  input: unknown,
  previousResource?: GenericResource,
): Promise<GenericResource> {
  const resource = previousResource ?? await getGenericResource(env, spaceId, model, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  const prepared = hasTemporalCapability(model)
    ? prepareTemporalUpdate(model, resource, input)
    : hasCalendarCapability(model)
      ? prepareCalendarUpdate(model, resource, input)
      : input;
  return updateGenericResource(env, principal, spaceId, model, recordId, expectedVersion, prepared, "client", undefined, resource);
}

export async function prepareCapabilityUpdatePolicyInput(env: Bindings, spaceId: string, model: PublishedModel, recordId: string, input: unknown) {
  const resource = await getGenericResource(env, spaceId, model, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (hasTemporalCapability(model)) return { resource, prepared: prepareTemporalUpdate(model, resource, input) };
  if (hasCalendarCapability(model)) return { resource, prepared: prepareCalendarUpdate(model, resource, input) };
  return { resource, prepared: input as Record<string, unknown> };
}

export async function decorateCapabilityResponse(env: Bindings, spaceId: string, model: PublishedModel, resource: GenericResource): Promise<CapabilityResponseDecoration> {
  if (!hasTemporalCapability(model)) return {};
  const space = await loadSpaceTemporalContext(env, spaceId);
  return { computed: { temporal: computeTemporalResource(model, resource, space) } };
}

export async function decorateCapabilityResponses(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  resources: readonly GenericResource[],
): Promise<CapabilityResponseDecoration[]> {
  if (!hasTemporalCapability(model)) return resources.map(() => ({}));
  const space = await loadSpaceTemporalContext(env, spaceId);
  return resources.map((resource) => ({ computed: { temporal: computeTemporalResource(model, resource, space) } }));
}

export function capabilityActionAccess(model: PublishedModel, actionKey: string): "write" | null {
  if (hasTemporalCapability(model) && actionKey === "record-occurrence" && model.definition.capabilities?.temporal?.occurrences === true) return "write";
  return null;
}

function actionBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Capability action body must be an object", 400);
  return value as Record<string, unknown>;
}

export async function executeCapabilityAction(env: Bindings, principal: Principal, spaceId: string, model: PublishedModel, recordId: string, actionKey: string, inputValue: unknown): Promise<GenericResource> {
  if (!capabilityActionAccess(model, actionKey)) throw new ApiError("ACTION_NOT_FOUND", `Action ${actionKey} is not defined for model ${model.key}`, 404);
  const input = actionBody(inputValue);
  if (Object.keys(input).some((key) => !["version", "occurredOn", "note"].includes(key))) throw new ApiError("INVALID_REQUEST", "record-occurrence accepts only version, occurredOn, and note", 400);
  if (!Number.isInteger(input.version) || Number(input.version) < 1) throw new ApiError("INVALID_REQUEST", "version must be a positive integer", 400);
  const space = await loadSpaceTemporalContext(env, spaceId);
  const result = await recordTemporalOccurrence(env, principal, space, model, recordId, Number(input.version), input.occurredOn, input.note);
  return result.record;
}

export async function listCapabilityOccurrences(env: Bindings, spaceId: string, model: PublishedModel, recordId: string, limit: number, cursor?: string): Promise<CapabilityOccurrenceList> {
  if (!hasTemporalCapability(model) || model.definition.capabilities?.temporal?.occurrences !== true) throw new ApiError("OCCURRENCE_NOT_ALLOWED", `Model ${model.key} does not expose Temporal occurrences`, 404);
  return listTemporalOccurrences(env, spaceId, model, recordId, limit, cursor);
}

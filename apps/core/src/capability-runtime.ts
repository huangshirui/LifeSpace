import type { Bindings, Principal } from "./env";
import {
  createGenericResource,
  getGenericResource,
  updateGenericResource,
  type GenericResource,
} from "./generic-resource";
import { ApiError } from "./http";
import type { PublishedModel } from "./model-registry";
import {
  computeTemporalResource,
  createTemporalResource,
  listTemporalOccurrences,
  loadSpaceTemporalContext,
  prepareTemporalUpdate,
  recordTemporalOccurrence,
  updateTemporalResource,
  type TemporalOccurrence,
} from "./temporal-capability";

export type CapabilityResponseDecoration = {
  computed?: {
    temporal?: ReturnType<typeof computeTemporalResource>;
  };
};

export type CapabilityOccurrenceList = {
  items: TemporalOccurrence[];
  nextCursor: string | null;
};

export function hasTemporalCapability(model: PublishedModel): boolean {
  return Boolean(model.definition.capabilities?.temporal);
}

export async function createCapabilityAwareResource(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  input: unknown,
): Promise<GenericResource> {
  if (hasTemporalCapability(model)) {
    const space = await loadSpaceTemporalContext(env, spaceId);
    return createTemporalResource(env, principal, space, model, input);
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
): Promise<GenericResource> {
  if (hasTemporalCapability(model)) {
    const space = await loadSpaceTemporalContext(env, spaceId);
    return updateTemporalResource(env, principal, space, model, recordId, expectedVersion, input);
  }
  return updateGenericResource(env, principal, spaceId, model, recordId, expectedVersion, input);
}

export async function decorateCapabilityResponse(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  resource: GenericResource,
): Promise<CapabilityResponseDecoration> {
  if (!hasTemporalCapability(model)) return {};
  const space = await loadSpaceTemporalContext(env, spaceId);
  return { computed: { temporal: computeTemporalResource(model, resource, space) } };
}

export function capabilityActionAccess(model: PublishedModel, actionKey: string): "write" | null {
  if (hasTemporalCapability(model) && actionKey === "record-occurrence" && model.definition.capabilities?.temporal?.occurrences === true) return "write";
  return null;
}

function actionBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Capability action body must be an object", 400);
  return value as Record<string, unknown>;
}

export async function executeCapabilityAction(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  actionKey: string,
  inputValue: unknown,
): Promise<GenericResource> {
  const access = capabilityActionAccess(model, actionKey);
  if (!access) throw new ApiError("ACTION_NOT_FOUND", `Action ${actionKey} is not defined for model ${model.key}`, 404);
  const input = actionBody(inputValue);
  if (actionKey === "record-occurrence") {
    if (Object.keys(input).some((key) => !["version", "occurredOn", "note"].includes(key))) {
      throw new ApiError("INVALID_REQUEST", "record-occurrence accepts only version, occurredOn, and note", 400);
    }
    if (!Number.isInteger(input.version) || Number(input.version) < 1) throw new ApiError("INVALID_REQUEST", "version must be a positive integer", 400);
    const space = await loadSpaceTemporalContext(env, spaceId);
    const result = await recordTemporalOccurrence(
      env,
      principal,
      space,
      model,
      recordId,
      Number(input.version),
      input.occurredOn,
      input.note,
    );
    return result.record;
  }
  throw new ApiError("ACTION_NOT_FOUND", `Action ${actionKey} is not defined for model ${model.key}`, 404);
}

export async function listCapabilityOccurrences(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  limit: number,
  cursor?: string,
): Promise<CapabilityOccurrenceList> {
  if (!hasTemporalCapability(model) || model.definition.capabilities?.temporal?.occurrences !== true) {
    throw new ApiError("OCCURRENCE_NOT_ALLOWED", `Model ${model.key} does not expose Temporal occurrences`, 404);
  }
  return listTemporalOccurrences(env, spaceId, model, recordId, limit, cursor);
}

export async function validateCapabilityUpdatePolicyInput(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  recordId: string,
  input: unknown,
): Promise<{ resource: GenericResource; prepared: Record<string, unknown> }> {
  const resource = await getGenericResource(env, spaceId, model.key, recordId);
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (!hasTemporalCapability(model)) return { resource, prepared: input as Record<string, unknown> };
  return { resource, prepared: prepareTemporalUpdate(model, resource, input) };
}

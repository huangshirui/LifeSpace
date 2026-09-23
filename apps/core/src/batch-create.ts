import type { Context, Hono } from "hono";
import {
  hasTemporalCapability,
  prepareCapabilityAwareResourceCreate,
  prepareCapabilityCreateInput,
} from "./capability-runtime";
import type { Bindings, Principal, Variables } from "./env";
import { commitPreparedGenericResourceCreates, type PreparedGenericResourceCreate } from "./generic-resource";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { provenanceMutationExtension, splitProvenanceEnvelope } from "./resource-provenance";
import { loadSpaceTemporalContext, type SpaceTemporalContext } from "./temporal-capability";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type JsonObject = Record<string, unknown>;

type BatchCreateItem = {
  clientRef?: string;
  modelKey: string;
  input: JsonObject;
};

type AuthorizedModel = {
  model: PublishedModel;
  principal: Principal;
  actorPersonId: string | null;
};

const MAX_BATCH_CREATE_ITEMS = 20;
const MODEL_KEY = /^[a-z][a-z0-9_]{1,62}$/u;

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", `${path} must be an object`, 400);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `${path}.${unknown} is not supported`, 400);
}

function parseBatchCreateRequest(value: unknown): BatchCreateItem[] {
  const request = object(value, "request");
  onlyKeys(request, ["items"], "request");
  if (!Array.isArray(request.items) || request.items.length < 1 || request.items.length > MAX_BATCH_CREATE_ITEMS) {
    throw new ApiError("INVALID_REQUEST", `items must contain 1-${MAX_BATCH_CREATE_ITEMS} entries`, 400);
  }

  const clientRefs = new Set<string>();
  return request.items.map((raw, index) => {
    const item = object(raw, `items[${index}]`);
    onlyKeys(item, ["clientRef", "modelKey", "input"], `items[${index}]`);

    if (typeof item.modelKey !== "string" || !MODEL_KEY.test(item.modelKey)) {
      throw new ApiError("INVALID_REQUEST", `items[${index}].modelKey is invalid`, 400);
    }
    const input = object(item.input, `items[${index}].input`);

    let clientRef: string | undefined;
    if (item.clientRef !== undefined) {
      if (typeof item.clientRef !== "string" || !item.clientRef.trim() || item.clientRef.length > 100) {
        throw new ApiError("INVALID_REQUEST", `items[${index}].clientRef must contain 1-100 characters`, 400);
      }
      clientRef = item.clientRef;
      if (clientRefs.has(clientRef)) {
        throw new ApiError("INVALID_REQUEST", `items[${index}].clientRef must be unique within the batch`, 400);
      }
      clientRefs.add(clientRef);
    }

    return {
      ...(clientRef === undefined ? {} : { clientRef }),
      modelKey: item.modelKey,
      input,
    };
  });
}

function clonePrincipal(principal: Principal): Principal {
  return {
    ...principal,
    scopes: [...principal.scopes],
    ...(principal.actor ? { actor: { ...principal.actor } } : {}),
    activeDelegationId: undefined,
  };
}

function contextualizeItemError(error: unknown, item: BatchCreateItem, index: number): never {
  if (error instanceof ApiError) {
    const ref = item.clientRef ? ` clientRef=${item.clientRef}` : "";
    throw new ApiError(error.code, `items[${index}]${ref}: ${error.message}`, error.status);
  }
  throw error;
}

async function authorizeModels(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  modelKeys: readonly string[],
): Promise<Map<string, AuthorizedModel>> {
  const result = new Map<string, AuthorizedModel>();
  for (const modelKey of [...new Set(modelKeys)]) {
    const model = await getRuntimeModel(env, modelKey);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${modelKey} not found`, 404);
    const scopedPrincipal = clonePrincipal(principal);
    const access = await requireModelAccess(env, scopedPrincipal, spaceId, model, "write");
    result.set(modelKey, {
      model,
      principal: scopedPrincipal,
      actorPersonId: access.actorPersonId,
    });
  }
  return result;
}

export function registerBatchCreateRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/records/batch", async (context: Context<AppEnv>) => {
    const spaceId = context.req.param("spaceId");
    if (!spaceId) throw new ApiError("NOT_FOUND", "Space path parameter is missing", 404);

    const raw = await context.req.json<unknown>().catch(() => null);
    const items = parseBatchCreateRequest(raw);
    const authorized = await authorizeModels(
      context.env,
      context.get("principal"),
      spaceId,
      items.map((item) => item.modelKey),
    );

    let temporalContext: SpaceTemporalContext | undefined;
    if ([...authorized.values()].some(({ model }) => hasTemporalCapability(model))) {
      temporalContext = await loadSpaceTemporalContext(context.env, spaceId);
    }

    const prepared: PreparedGenericResourceCreate[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const access = authorized.get(item.modelKey)!;
      try {
        const { data, provenance } = splitProvenanceEnvelope(item.input);
        const policyInput = prepareCapabilityCreateInput(access.model, data);
        await requireModelPolicy(
          context.env,
          access.principal,
          spaceId,
          access.model,
          "create",
          undefined,
          policyInput,
          { personId: access.actorPersonId },
        );
        prepared.push(await prepareCapabilityAwareResourceCreate(
          context.env,
          access.principal,
          spaceId,
          access.model,
          data,
          provenance ? provenanceMutationExtension(provenance) : undefined,
          temporalContext,
        ));
      } catch (error) {
        contextualizeItemError(error, item, index);
      }
    }

    let created;
    try {
      created = await commitPreparedGenericResourceCreates(context.env, spaceId, prepared);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(error.code, `Batch create failed: ${error.message}`, error.status);
      }
      throw error;
    }

    return context.json(success({
      items: created.map((resource, index) => ({
        ...(items[index]?.clientRef === undefined ? {} : { clientRef: items[index]!.clientRef }),
        modelKey: resource.modelKey,
        id: resource.id,
        version: resource.version,
        createdAt: resource.createdAt,
      })),
    }), 201);
  });
}

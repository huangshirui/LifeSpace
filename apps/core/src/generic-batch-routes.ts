import type { Context, Hono } from "hono";
import {
  hasTemporalCapability,
  prepareCapabilityCreateInput,
  prepareCapabilityCreateMutation,
  prepareCapabilityUpdateMutation,
} from "./capability-runtime";
import type { Bindings, Principal, Variables } from "./env";
import {
  prepareCreateGenericMutation,
  prepareUpdateGenericMutation,
  type GenericResource,
  type PreparedCreateMutation,
  type PreparedUpdateMutation,
  type ResourceMutationExtension,
} from "./generic-resource";
import { ApiError, success } from "./http";
import {
  type ModelAccessDecision,
} from "./model-authorization";
import type { PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { loadSpaceTemporalContext, type SpaceTemporalContext } from "./temporal-capability";
import { executeNativeModelBatch } from "./native-model-batch";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type OperationKind = "create" | "update" | "delete";
export type BatchOperation = {
  operation: OperationKind;
  modelKey: string;
  recordId: string | null;
  version: number | null;
  data: Record<string, unknown> | null;
  delegationId: string | null;
  newRecordId?: string;
};
type PlannedInput = {
  operation: BatchOperation;
  model: PublishedModel;
  decision: ModelAccessDecision;
  previous: GenericResource | null;
  preparedCreate?: PreparedCreateMutation;
  preparedUpdate?: PreparedUpdateMutation;
  extension?: ResourceMutationExtension;
};
const modelKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,99}$/u;
const recordIdPattern = /^rec_[A-Za-z0-9_-]+$/u;
const delegationIdPattern = /^dlg_[A-Za-z0-9_-]+$/u;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", message, 400);
  }
  return value as Record<string, unknown>;
}

function optionalPositiveVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ApiError("INVALID_REQUEST", "Batch operation version must be a positive integer when supplied", 400);
  }
  return Number(value);
}

function optionalDelegationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !delegationIdPattern.test(value)) {
    throw new ApiError("INVALID_REQUEST", "delegationId must be a valid dlg_* identifier", 400);
  }
  return value;
}

export function parseOperation(value: unknown, index: number): BatchOperation {
  const input = object(value, `Batch operation ${index} must be an object`);
  const operation = input.operation;
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new ApiError("INVALID_REQUEST", `Batch operation ${index} has an unsupported operation`, 400);
  }
  if (typeof input.modelKey !== "string" || !modelKeyPattern.test(input.modelKey)) {
    throw new ApiError("INVALID_REQUEST", `Batch operation ${index} has an invalid modelKey`, 400);
  }
  const delegationId = optionalDelegationId(input.delegationId);

  if (operation === "create") {
    const allowed = new Set(["operation", "modelKey", "data", "delegationId"]);
    const extra = Object.keys(input).find((key) => !allowed.has(key));
    if (extra) throw new ApiError("INVALID_REQUEST", `Batch create ${index} does not allow ${extra}`, 400);
    return {
      operation,
      modelKey: input.modelKey,
      recordId: null,
      version: null,
      data: object(input.data, `Batch create ${index} data must be an object`),
      delegationId,
    };
  }

  if (typeof input.recordId !== "string" || !recordIdPattern.test(input.recordId)) {
    throw new ApiError("INVALID_REQUEST", `Batch operation ${index} has an invalid recordId`, 400);
  }
  const version = optionalPositiveVersion(input.version);
  if (operation === "delete") {
    const allowed = new Set(["operation", "modelKey", "recordId", "version", "delegationId"]);
    const extra = Object.keys(input).find((key) => !allowed.has(key));
    if (extra) throw new ApiError("INVALID_REQUEST", `Batch delete ${index} does not allow ${extra}`, 400);
    return {
      operation,
      modelKey: input.modelKey,
      recordId: input.recordId,
      version,
      data: null,
      delegationId,
    };
  }

  const allowed = new Set(["operation", "modelKey", "recordId", "version", "data", "delegationId"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) throw new ApiError("INVALID_REQUEST", `Batch update ${index} does not allow ${extra}`, 400);
  const data = object(input.data, `Batch update ${index} data must be an object`);
  if (!Object.keys(data).length) {
    throw new ApiError("INVALID_REQUEST", `Batch update ${index} requires at least one field change`, 400);
  }
  return {
    operation,
    modelKey: input.modelKey,
    recordId: input.recordId,
    version,
    data,
    delegationId,
  };
}

export async function prepareOperations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  operations: readonly BatchOperation[],
  models: readonly PublishedModel[],
  decisions: readonly ModelAccessDecision[],
  previousById: Map<string, GenericResource>,
  sharedTemporalContext?: SpaceTemporalContext,
): Promise<PlannedInput[]> {
  const needsTemporalContext = models.some((model, index) =>
    operations[index]!.operation === "create" && hasTemporalCapability(model)
  );
  const temporalContext: SpaceTemporalContext | undefined = sharedTemporalContext ?? (needsTemporalContext
    ? await loadSpaceTemporalContext(env, spaceId)
    : undefined);

  const output: PlannedInput[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index]!;
    const model = models[index]!;
    const decision = decisions[index]!;

    if (operation.operation === "create") {
      const policyInput = prepareCapabilityCreateInput(model, operation.data!);
      await requireModelPolicy(
        env,
        principal,
        spaceId,
        model,
        "create",
        undefined,
        policyInput,
        { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId },
      );
      const capability = await prepareCapabilityCreateMutation(
        env,
        spaceId,
        model,
        operation.data!,
        undefined,
        temporalContext,
      );
      output.push({
        operation,
        model,
        decision,
        previous: null,
        preparedCreate: prepareCreateGenericMutation(
          model,
          capability.prepared,
          capability.trusted,
        ),
        extension: capability.extension,
      });
      continue;
    }

    const previous = previousById.get(operation.recordId!);
    if (!previous || previous.modelKey !== model.key) {
      throw new ApiError(
        "RESOURCE_NOT_FOUND",
        `Batch target ${operation.recordId} was not found in model ${model.key}`,
        404,
      );
    }

    if (operation.operation === "delete") {
      await requireModelPolicy(
        env,
        principal,
        spaceId,
        model,
        "delete",
        previous,
        undefined,
        { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId },
      );
      output.push({ operation, model, decision, previous });
      continue;
    }

    const preparedInput = prepareCapabilityUpdateMutation(model, previous, operation.data!);
    await requireModelPolicy(
      env,
      principal,
      spaceId,
      model,
      "update",
      previous,
      preparedInput,
      { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId },
    );
    output.push({
      operation,
      model,
      decision,
      previous,
      preparedUpdate: prepareUpdateGenericMutation(
        model,
        preparedInput,
        previous,
        "client",
      ),
    });
  }
  return output;
}

export function registerGenericBatchRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/models/batch", async (context: Context<AppEnv>) => {
    const spaceId = context.req.param("spaceId");
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
    const body = await context.req.json<unknown>().catch(() => null);
    return context.json(success(await executeNativeModelBatch(context.env, context.get("principal"),
      spaceId, body, context.req.header("x-lifespace-delegation-id")?.trim() || null)));
  });
}

import type { Context, Hono } from "hono";
import {
  hasTemporalCapability,
  prepareCapabilityCreateInput,
  prepareCapabilityCreateMutation,
  prepareCapabilityUpdateMutation,
} from "./capability-runtime";
import type { Bindings, Principal, Variables } from "./env";
import {
  planCreateGenericMutation,
  planDeleteGenericMutation,
  planUpdateGenericMutation,
  prepareCreateGenericMutation,
  prepareUpdateGenericMutation,
  validateRelationProjections,
  type GenericResource,
  type PreparedCreateMutation,
  type PreparedUpdateMutation,
  type ResourceMutationExtension,
  type ResourceMutationPlan,
} from "./generic-resource";
import { ApiError, success } from "./http";
import {
  requireModelAccessMany,
  type ModelAccessDecision,
  type ModelAccessRequest,
} from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { loadSpaceTemporalContext, type SpaceTemporalContext } from "./temporal-capability";
import { getTypedResourcesByModels } from "./typed-resource-batch";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type OperationKind = "create" | "update" | "delete";
type BatchOperation = {
  operation: OperationKind;
  modelKey: string;
  recordId: string | null;
  version: number | null;
  data: Record<string, unknown> | null;
  delegationId: string | null;
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

const MAX_BATCH_OPERATIONS = 20;
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

function parseOperation(value: unknown, index: number): BatchOperation {
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

function parseBatch(value: unknown): BatchOperation[] {
  const input = object(value, "Batch body must be an object");
  if (Object.keys(input).some((key) => key !== "operations")) {
    throw new ApiError("INVALID_REQUEST", "Batch body accepts only operations", 400);
  }
  if (!Array.isArray(input.operations)
      || input.operations.length < 1
      || input.operations.length > MAX_BATCH_OPERATIONS) {
    throw new ApiError(
      "INVALID_REQUEST",
      `operations must contain 1-${MAX_BATCH_OPERATIONS} items`,
      400,
    );
  }
  const operations = input.operations.map(parseOperation);
  const existingTargets = operations
    .filter((operation) => operation.recordId)
    .map((operation) => operation.recordId!);
  if (new Set(existingTargets).size !== existingTargets.length) {
    throw new ApiError(
      "INVALID_REQUEST",
      "One existing record may appear at most once in a Batch",
      400,
    );
  }
  return operations;
}

async function modelsForOperations(
  env: Bindings,
  operations: readonly BatchOperation[],
): Promise<PublishedModel[]> {
  const cache = new Map<string, PublishedModel>();
  for (const operation of operations) {
    if (cache.has(operation.modelKey)) continue;
    const model = await getRuntimeModel(env, operation.modelKey);
    if (!model) {
      throw new ApiError("MODEL_NOT_FOUND", `Published model ${operation.modelKey} not found`, 404);
    }
    cache.set(operation.modelKey, model);
  }
  return operations.map((operation) => cache.get(operation.modelKey)!);
}

function authorityRequests(
  operations: readonly BatchOperation[],
  models: readonly PublishedModel[],
): ModelAccessRequest[] {
  return operations.map((operation, index) => ({
    model: models[index]!,
    required: "write",
    selector: {
      delegationId: operation.delegationId,
      ...(operation.recordId ? { recordId: operation.recordId } : {}),
    },
  }));
}

function rejectRepeatedSingleUse(decisions: readonly ModelAccessDecision[]): void {
  const seen = new Set<string>();
  for (const decision of decisions) {
    for (const delegationId of decision.authority.singleUseDelegationIds) {
      if (seen.has(delegationId)) {
        throw new ApiError(
          "DELEGATION_INVALID",
          "One single-use Delegation ancestor cannot authorize two operations in the same Batch",
          403,
        );
      }
      seen.add(delegationId);
    }
  }
}

async function loadExistingResources(
  env: Bindings,
  spaceId: string,
  operations: readonly BatchOperation[],
  models: readonly PublishedModel[],
): Promise<Map<string, GenericResource>> {
  const idsByModel = new Map<string, { model: PublishedModel; ids: string[] }>();
  operations.forEach((operation, index) => {
    if (!operation.recordId) return;
    const model = models[index]!;
    const group = idsByModel.get(model.key) ?? { model, ids: [] };
    group.ids.push(operation.recordId);
    idsByModel.set(model.key, group);
  });
  return getTypedResourcesByModels(env, spaceId, [...idsByModel.values()]);
}

function actor(principal: Principal) {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

async function prepareOperations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  operations: readonly BatchOperation[],
  models: readonly PublishedModel[],
  decisions: readonly ModelAccessDecision[],
  previousById: Map<string, GenericResource>,
): Promise<PlannedInput[]> {
  const needsTemporalContext = models.some((model, index) =>
    operations[index]!.operation === "create" && hasTemporalCapability(model)
  );
  const temporalContext: SpaceTemporalContext | undefined = needsTemporalContext
    ? await loadSpaceTemporalContext(env, spaceId)
    : undefined;

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

async function buildPlans(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  prepared: readonly PlannedInput[],
  changeSetId: string,
  timestamp: string,
): Promise<ResourceMutationPlan[]> {
  const plans: ResourceMutationPlan[] = [];
  for (const entry of prepared) {
    const attribution = {
      delegationId: entry.decision.authority.delegationId,
      delegationChain: entry.decision.authority.delegationChain,
      changeSetId,
    };
    if (entry.operation.operation === "create") {
      plans.push(await planCreateGenericMutation(
        env,
        principal,
        spaceId,
        entry.model,
        entry.preparedCreate!,
        entry.extension,
        attribution,
        timestamp,
      ));
    } else if (entry.operation.operation === "update") {
      plans.push(await planUpdateGenericMutation(
        env,
        principal,
        spaceId,
        entry.model,
        entry.previous!,
        entry.operation.version ?? entry.previous!.version,
        entry.preparedUpdate!,
        "client",
        undefined,
        undefined,
        attribution,
        timestamp,
      ));
    } else {
      plans.push(planDeleteGenericMutation(
        env,
        principal,
        spaceId,
        entry.model,
        entry.previous!,
        entry.operation.version ?? entry.previous!.version,
        attribution,
        timestamp,
      ));
    }
  }
  return plans;
}

function mapCommitError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CHANGE_SET_INCOMPLETE")) {
    throw new ApiError(
      "VERSION_CONFLICT",
      "Batch could not commit because at least one target changed concurrently",
      409,
    );
  }
  if (message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE")) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "A single-use Delegation was consumed, revoked or expired before Batch commit",
      403,
    );
  }
  throw error;
}

export function registerGenericBatchRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/models/batch", async (context: Context<AppEnv>) => {
    const principal = context.get("principal");
    const spaceId = context.req.param("spaceId");
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
    const body = await context.req.json<unknown>().catch(() => null);
    const operations = parseBatch(body);
    const models = await modelsForOperations(context.env, operations);

    const decisions = await requireModelAccessMany(
      context.env,
      principal,
      spaceId,
      authorityRequests(operations, models),
    );
    rejectRepeatedSingleUse(decisions);
    const executionPrincipal = decisions[0]!.principal;
    if (decisions.some((decision) =>
      decision.principal.type !== executionPrincipal.type
      || decision.principal.id !== executionPrincipal.id
      || decision.principal.actor?.type !== executionPrincipal.actor?.type
      || decision.principal.actor?.id !== executionPrincipal.actor?.id
    )) {
      throw new ApiError("DELEGATION_INVALID", "Batch operations must resolve to one Execution Principal", 403);
    }

    const previousById = await loadExistingResources(
      context.env,
      spaceId,
      operations,
      models,
    );
    const prepared = await prepareOperations(
      context.env,
      executionPrincipal,
      spaceId,
      operations,
      models,
      decisions,
      previousById,
    );

    const allRelations = prepared.flatMap((entry) => [
      ...(entry.preparedCreate?.relations ?? []),
      ...(entry.preparedUpdate?.relations ?? []),
    ]);
    await validateRelationProjections(context.env, spaceId, allRelations);

    const changeSetId = `cgs_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date().toISOString();
    const plans = await buildPlans(
      context.env,
      executionPrincipal,
      spaceId,
      prepared,
      changeSetId,
      timestamp,
    );
    const executedBy = actor(executionPrincipal);

    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(`INSERT INTO resource_change_sets(
        id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,
        operation_count,occurred_at,committed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,NULL)`).bind(
        changeSetId,
        spaceId,
        executionPrincipal.clientId,
        executionPrincipal.type,
        executionPrincipal.id,
        executedBy.type,
        executedBy.id,
        operations.length,
        timestamp,
      ),
      ...plans.flatMap((plan) => plan.statements),
      context.env.DB.prepare(`UPDATE resource_change_sets
        SET committed_at=?
        WHERE id=? AND committed_at IS NULL`).bind(timestamp, changeSetId),
    ];

    try {
      await context.env.DB.batch(statements);
    } catch (error) {
      mapCommitError(error);
    }

    return context.json(success({
      changeSetId,
      items: plans.map((plan, index) => ({
        index,
        operation: operations[index]!.operation,
        modelKey: operations[index]!.modelKey,
        recordId: plan.resource?.id ?? operations[index]!.recordId!,
        version: plan.resource?.version ?? (prepared[index]!.previous!.version + 1),
      })),
    }));
  });
}

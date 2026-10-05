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
  validateRelationProjectionGroups,
  type GenericResource,
  type PreparedCreateMutation,
  type PreparedUpdateMutation,
  type ResourceMutationExtension,
  type ResourceMutationPlan,
} from "./generic-resource";
import { ApiError, success } from "./http";
import {
  evaluateModelAccessMany,
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
type BulkOperation = {
  operation: OperationKind;
  modelKey: string;
  recordId: string | null;
  version: number | null;
  data: Record<string, unknown> | null;
  delegationId: string | null;
};
type PreparedBulkItem = {
  index: number;
  operation: BulkOperation;
  model: PublishedModel;
  decision: ModelAccessDecision;
  previous: GenericResource | null;
  preparedCreate?: PreparedCreateMutation;
  preparedUpdate?: PreparedUpdateMutation;
  extension?: ResourceMutationExtension;
};
type BulkError = { code: string; message: string; status: number };
type ItemState = {
  index: number;
  raw: unknown;
  operation?: BulkOperation;
  model?: PublishedModel;
  decision?: ModelAccessDecision;
  previous?: GenericResource | null;
  prepared?: PreparedBulkItem;
  plan?: ResourceMutationPlan;
  error?: ApiError;
};

const MAX_BULK_OPERATIONS = 20;
const modelKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,99}$/u;
const recordIdPattern = /^rec_[A-Za-z0-9_-]+$/u;
const delegationIdPattern = /^dlg_[A-Za-z0-9_-]+$/u;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", message, 400);
  return value as Record<string, unknown>;
}
function optionalPositiveVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1) throw new ApiError("INVALID_REQUEST", "Bulk operation version must be a positive integer when supplied", 400);
  return Number(value);
}
function optionalDelegationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !delegationIdPattern.test(value)) throw new ApiError("INVALID_REQUEST", "delegationId must be a valid dlg_* identifier", 400);
  return value;
}
function parseOperation(value: unknown, index: number): BulkOperation {
  const input = object(value, `Bulk operation ${index} must be an object`);
  const operation = input.operation;
  if (operation !== "create" && operation !== "update" && operation !== "delete") throw new ApiError("INVALID_REQUEST", `Bulk operation ${index} has an unsupported operation`, 400);
  if (typeof input.modelKey !== "string" || !modelKeyPattern.test(input.modelKey)) throw new ApiError("INVALID_REQUEST", `Bulk operation ${index} has an invalid modelKey`, 400);
  const delegationId = optionalDelegationId(input.delegationId);
  if (operation === "create") {
    const allowed = new Set(["operation", "modelKey", "data", "delegationId"]);
    const extra = Object.keys(input).find((key) => !allowed.has(key));
    if (extra) throw new ApiError("INVALID_REQUEST", `Bulk create ${index} does not allow ${extra}`, 400);
    return { operation, modelKey: input.modelKey, recordId: null, version: null, data: object(input.data, `Bulk create ${index} data must be an object`), delegationId };
  }
  if (typeof input.recordId !== "string" || !recordIdPattern.test(input.recordId)) throw new ApiError("INVALID_REQUEST", `Bulk operation ${index} has an invalid recordId`, 400);
  const version = optionalPositiveVersion(input.version);
  if (operation === "delete") {
    const allowed = new Set(["operation", "modelKey", "recordId", "version", "delegationId"]);
    const extra = Object.keys(input).find((key) => !allowed.has(key));
    if (extra) throw new ApiError("INVALID_REQUEST", `Bulk delete ${index} does not allow ${extra}`, 400);
    return { operation, modelKey: input.modelKey, recordId: input.recordId, version, data: null, delegationId };
  }
  const allowed = new Set(["operation", "modelKey", "recordId", "version", "data", "delegationId"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) throw new ApiError("INVALID_REQUEST", `Bulk update ${index} does not allow ${extra}`, 400);
  const data = object(input.data, `Bulk update ${index} data must be an object`);
  if (!Object.keys(data).length) throw new ApiError("INVALID_REQUEST", `Bulk update ${index} requires at least one field change`, 400);
  return { operation, modelKey: input.modelKey, recordId: input.recordId, version, data, delegationId };
}
function parseEnvelope(value: unknown): unknown[] {
  const input = object(value, "Bulk body must be an object");
  if (Object.keys(input).some((key) => key !== "operations")) throw new ApiError("INVALID_REQUEST", "Bulk body accepts only operations", 400);
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_BULK_OPERATIONS) throw new ApiError("INVALID_REQUEST", `operations must contain 1-${MAX_BULK_OPERATIONS} items`, 400);
  return input.operations;
}
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  throw error;
}
function errorDto(error: ApiError): BulkError { return { code: error.code, message: error.message, status: error.status }; }
function actor(principal: Principal) { return principal.actor ?? { type: principal.type, id: principal.id }; }

async function loadExistingResources(env: Bindings, spaceId: string, items: readonly ItemState[]): Promise<Map<string, GenericResource>> {
  const idsByModel = new Map<string, { model: PublishedModel; ids: string[] }>();
  for (const item of items) {
    if (item.error || !item.operation?.recordId || !item.model) continue;
    const group = idsByModel.get(item.model.key) ?? { model: item.model, ids: [] };
    group.ids.push(item.operation.recordId);
    idsByModel.set(item.model.key, group);
  }
  if (!idsByModel.size) return new Map();
  return getTypedResourcesByModels(env, spaceId, [...idsByModel.values()]);
}

async function prepareItems(env: Bindings, principal: Principal, spaceId: string, items: ItemState[]): Promise<void> {
  const needsTemporal = items.some((item) => !item.error && item.operation?.operation === "create" && item.model && hasTemporalCapability(item.model));
  const temporalContext: SpaceTemporalContext | undefined = needsTemporal ? await loadSpaceTemporalContext(env, spaceId) : undefined;
  for (const item of items) {
    if (item.error || !item.operation || !item.model || !item.decision) continue;
    try {
      const operation = item.operation;
      const model = item.model;
      const decision = item.decision;
      if (operation.operation === "create") {
        const policyInput = prepareCapabilityCreateInput(model, operation.data!);
        await requireModelPolicy(env, principal, spaceId, model, "create", undefined, policyInput, { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId });
        const capability = await prepareCapabilityCreateMutation(env, spaceId, model, operation.data!, undefined, temporalContext);
        item.prepared = { index: item.index, operation, model, decision, previous: null, preparedCreate: prepareCreateGenericMutation(model, capability.prepared, capability.trusted), extension: capability.extension };
        continue;
      }
      const previous = item.previous;
      if (!previous || previous.modelKey !== model.key) throw new ApiError("RESOURCE_NOT_FOUND", `Bulk target ${operation.recordId} was not found in model ${model.key}`, 404);
      if (operation.version !== null && operation.version !== previous.version) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
      if (operation.operation === "delete") {
        await requireModelPolicy(env, principal, spaceId, model, "delete", previous, undefined, { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId });
        item.prepared = { index: item.index, operation, model, decision, previous };
        continue;
      }
      const preparedInput = prepareCapabilityUpdateMutation(model, previous, operation.data!);
      await requireModelPolicy(env, principal, spaceId, model, "update", previous, preparedInput, { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId });
      item.prepared = { index: item.index, operation, model, decision, previous, preparedUpdate: prepareUpdateGenericMutation(model, preparedInput, previous, "client") };
    } catch (error) {
      item.error = asApiError(error);
    }
  }
}

async function buildPlan(env: Bindings, principal: Principal, spaceId: string, entry: PreparedBulkItem, bulkId: string, timestamp: string): Promise<ResourceMutationPlan> {
  const attribution = { delegationId: entry.decision.authority.delegationId, delegationChain: entry.decision.authority.delegationChain, bulkId };
  if (entry.operation.operation === "create") return planCreateGenericMutation(env, principal, spaceId, entry.model, entry.preparedCreate!, entry.extension, attribution, timestamp);
  if (entry.operation.operation === "update") return planUpdateGenericMutation(env, principal, spaceId, entry.model, entry.previous!, entry.operation.version ?? entry.previous!.version, entry.preparedUpdate!, "client", undefined, undefined, attribution, timestamp);
  return planDeleteGenericMutation(env, principal, spaceId, entry.model, entry.previous!, entry.operation.version ?? entry.previous!.version, attribution, timestamp);
}

function singleUseFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE");
}
function commitRaceError(): ApiError { return new ApiError("VERSION_CONFLICT", "Bulk item target changed concurrently before commit", 409); }
function delegationRaceError(): ApiError { return new ApiError("DELEGATION_INVALID", "Single-use Delegation was consumed, revoked or expired before Bulk item commit", 403); }

async function finalizeBulk(env: Bindings, bulkId: string, timestamp: string): Promise<void> {
  await env.DB.prepare(`UPDATE resource_bulk_requests
    SET succeeded_count=(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
        failed_count=operation_count-(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
        completed_at=?
    WHERE id=? AND completed_at IS NULL`)
    .bind(bulkId, bulkId, timestamp, bulkId).run();
}

async function commitIndependently(env: Bindings, bulkId: string, plans: ItemState[], timestamp: string): Promise<void> {
  for (const item of plans) {
    if (!item.plan || item.error) continue;
    try {
      const results = await env.DB.batch(item.plan.statements);
      if (!results[0]?.meta.changes) item.error = commitRaceError();
    } catch (error) {
      if (singleUseFailure(error)) item.error = delegationRaceError();
      else throw error;
    }
  }
  await finalizeBulk(env, bulkId, timestamp);
}

export function registerGenericBulkRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/models/bulk", async (context: Context<AppEnv>) => {
    const authenticated = context.get("principal");
    const spaceId = context.req.param("spaceId");
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
    const body = await context.req.json<unknown>().catch(() => null);
    const raw = parseEnvelope(body);
    const items: ItemState[] = raw.map((value, index) => ({ index, raw: value }));

    const seenTargets = new Set<string>();
    for (const item of items) {
      try {
        item.operation = parseOperation(item.raw, item.index);
        if (item.operation.recordId) {
          const key = `${item.operation.modelKey}\u001f${item.operation.recordId}`;
          if (seenTargets.has(key)) throw new ApiError("INVALID_REQUEST", "One existing record may appear at most once in a Bulk", 400);
          seenTargets.add(key);
        }
      } catch (error) { item.error = asApiError(error); }
    }

    for (const item of items) {
      if (item.error || !item.operation) continue;
      const model = await getRuntimeModel(context.env, item.operation.modelKey);
      if (!model) item.error = new ApiError("MODEL_NOT_FOUND", `Published model ${item.operation.modelKey} not found`, 404);
      else item.model = model;
    }

    const candidates = items.filter((item) => !item.error && item.operation && item.model);
    const requests: ModelAccessRequest[] = candidates.map((item) => ({ model: item.model!, required: "write", selector: { delegationId: item.operation!.delegationId, ...(item.operation!.recordId ? { recordId: item.operation!.recordId } : {}) } }));
    const evaluations = await evaluateModelAccessMany(context.env, authenticated, spaceId, requests);
    evaluations.forEach((evaluation, offset) => {
      const item = candidates[offset]!;
      if (evaluation.ok) item.decision = evaluation.decision;
      else item.error = evaluation.error;
    });

    const validDecisions = items.filter((item) => !item.error && item.decision).map((item) => item.decision!);
    const executionPrincipal = validDecisions[0]?.principal ?? authenticated;
    if (validDecisions.some((decision) => decision.principal.type !== executionPrincipal.type || decision.principal.id !== executionPrincipal.id || decision.principal.actor?.type !== executionPrincipal.actor?.type || decision.principal.actor?.id !== executionPrincipal.actor?.id)) {
      throw new ApiError("DELEGATION_INVALID", "Bulk operations must resolve to one Execution Principal", 403);
    }

    const previousById = await loadExistingResources(context.env, spaceId, items);
    for (const item of items) if (!item.error && item.operation?.recordId) item.previous = previousById.get(item.operation.recordId) ?? null;
    await prepareItems(context.env, executionPrincipal, spaceId, items);

    const preparedItems = items.filter((item) => !item.error && item.prepared);
    const relationGroups = preparedItems.map((item) => [
      ...(item.prepared!.preparedCreate?.relations ?? []),
      ...(item.prepared!.preparedUpdate?.relations ?? []),
    ]);
    const relationErrors = await validateRelationProjectionGroups(context.env, spaceId, relationGroups);
    relationErrors.forEach((error, offset) => { if (error) preparedItems[offset]!.error = error; });

    const bulkId = `blk_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date().toISOString();
    for (const item of items) {
      if (item.error || !item.prepared) continue;
      item.plan = await buildPlan(context.env, executionPrincipal, spaceId, item.prepared, bulkId, timestamp);
    }
    const planned = items.filter((item) => item.plan && !item.error);
    const executedBy = actor(executionPrincipal);
    const insertBulk = context.env.DB.prepare(`INSERT INTO resource_bulk_requests(
      id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      bulkId, spaceId, executionPrincipal.clientId, executionPrincipal.type, executionPrincipal.id,
      executedBy.type, executedBy.id, items.length, timestamp,
    );
    const finalize = context.env.DB.prepare(`UPDATE resource_bulk_requests
      SET succeeded_count=(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
          failed_count=operation_count-(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
          completed_at=?
      WHERE id=? AND completed_at IS NULL`).bind(bulkId, bulkId, timestamp, bulkId);
    const statements: D1PreparedStatement[] = [insertBulk];
    const firstStatementIndexes = new Map<number, number>();
    for (const item of planned) {
      firstStatementIndexes.set(item.index, statements.length);
      statements.push(...item.plan!.statements);
    }
    statements.push(finalize);

    try {
      const results = await context.env.DB.batch(statements);
      for (const item of planned) {
        const firstResult = results[firstStatementIndexes.get(item.index)!];
        if (!firstResult?.meta.changes) item.error = commitRaceError();
      }
    } catch (error) {
      if (!singleUseFailure(error)) throw error;
      // The grouped D1 transaction was rolled back. Recreate the durable Bulk row,
      // then replay only surviving items independently. This bounded contention
      // slow path preserves partial success without making the normal path N RTTs.
      await context.env.DB.batch([insertBulk]);
      await commitIndependently(context.env, bulkId, planned, timestamp);
    }

    return context.json(success({
      bulkId,
      items: items.map((item) => {
        const operation = item.operation?.operation ?? (typeof (item.raw as any)?.operation === "string" ? (item.raw as any).operation : null);
        const modelKey = item.operation?.modelKey ?? (typeof (item.raw as any)?.modelKey === "string" ? (item.raw as any).modelKey : null);
        if (item.error || !item.plan) return { index: item.index, operation, modelKey, status: "failed", error: errorDto(item.error ?? new ApiError("INVALID_REQUEST", "Bulk item could not be prepared", 400)) };
        const version = item.plan.resource?.version ?? (item.prepared!.previous!.version + 1);
        return { index: item.index, operation: item.operation!.operation, modelKey: item.operation!.modelKey, status: "succeeded", recordId: item.plan.resource?.id ?? item.operation!.recordId!, version };
      }),
    }));
  });
}

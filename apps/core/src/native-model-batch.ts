import { prepareRecurrenceMutations } from "./recurrence-runtime";
import { hasTemporalCapability } from "./capability-runtime";
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import {
  parseOperation, prepareOperations, type BatchOperation,
} from "./generic-batch-routes";
import {
  planCreateGenericMutation, planUpdateGenericMutation, planDeleteGenericMutation,
  validateRelationProjectionGroups, validateFileProjectionGroups, type GenericResource, type ResourceMutationPlan,
} from "./generic-resource";
import { evaluateModelAccessMany, type ModelAccessDecision, type ModelAccessRequest } from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { bindEndpointModel, loadEndpointResources } from "./semantic-endpoints";
import { loadSpaceTemporalContext } from "./temporal-capability";
import { isSemanticRelationPredicate, type SemanticRelationPredicate } from "./semantic-relation-definition";
import { validateBatchSemanticRelation, validateBatchSemanticRelationAuthority } from "./semantic-relation-batch";

type Ref = { kind: "record"; modelKey: string; recordId?: string; clientRef?: string };
type Edge = { source: Ref; predicate: SemanticRelationPredicate; target: Ref; id?: string };
type Item = {
  index: number; raw: Record<string, unknown>; operation: string; delegationId: string | null;
  record?: BatchOperation; clientRef?: string; model?: PublishedModel; edges: Edge[];
  decisions: ModelAccessDecision[]; requestIndexes: number[]; error?: ApiError;
  prepared?: Awaited<ReturnType<typeof prepareOperations>>[number];
  plan?: ResourceMutationPlan; statements?: D1PreparedStatement[]; resultOffset?: number;
  result?: Record<string, unknown>; dependencies: Set<number>;
};
const REF = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/u;
const RECORD = /^rec_[A-Za-z0-9_-]+$/u;
const MODEL = /^[a-z][a-z0-9_]{1,62}$/u;
const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const asError = (error: unknown): ApiError => {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("SEMANTIC_RELATION_ENDPOINT_UNAVAILABLE")) return new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  if (message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE")) return new ApiError("DELEGATION_INVALID", "Delegation unavailable at commit", 403);
  if (message.includes("RECURRENCE_CURRENT_TASK_DELETE_FORBIDDEN")) return new ApiError("RECURRENCE_CURRENT_TASK_DELETE_FORBIDDEN", "Use skip-occurrence or remove the Plan recurrence before deleting the current Task", 409);
  if (message.includes("RECURRENCE_VERSION_CONFLICT")) return new ApiError("VERSION_CONFLICT", "Recurring plan changed before commit", 409);
  if (message.includes("CHANGE_SET_INCOMPLETE")) return new ApiError("VERSION_CONFLICT", "Batch target changed before commit", 409);
  throw error;
};
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiError("INVALID_REQUEST", "Batch item must be an object", 400);
  return raw as Record<string, unknown>;
}
function ref(raw: unknown): Ref {
  const input = object(raw);
  if (Object.keys(input).some((key) => !["kind", "modelKey", "recordId", "clientRef"].includes(key))
    || input.kind !== "record" || typeof input.modelKey !== "string" || !MODEL.test(input.modelKey)
    || (input.recordId === undefined) === (input.clientRef === undefined)
    || input.recordId !== undefined && (typeof input.recordId !== "string" || !RECORD.test(input.recordId))
    || input.clientRef !== undefined && (typeof input.clientRef !== "string" || !REF.test(input.clientRef))) {
    throw new ApiError("INVALID_REQUEST", "Endpoint requires modelKey and exactly one recordId or clientRef", 400);
  }
  return input as Ref;
}
function predicate(raw: unknown): SemanticRelationPredicate {
  if (typeof raw !== "string" || !isSemanticRelationPredicate(raw)) throw new ApiError("INVALID_REQUEST", "Unregistered predicate", 400);
  return raw;
}
function parseItem(raw: unknown, index: number, defaultDelegation: string | null): Item {
  const input = object(raw);
  const delegationId = input.delegationId === undefined ? defaultDelegation : input.delegationId;
  if (delegationId !== null && (typeof delegationId !== "string" || !/^dlg_[A-Za-z0-9_-]+$/u.test(delegationId))) {
    throw new ApiError("INVALID_REQUEST", "Invalid delegationId", 400);
  }
  const item: Item = { index, raw: input, operation: String(input.operation), delegationId,
    edges: [], decisions: [], requestIndexes: [], dependencies: new Set() };
  if (input.operation === "relation_create" || input.operation === "relation_delete") {
    const keys = input.operation === "relation_create"
      ? ["operation", "source", "predicate", "target", "delegationId"] : ["operation", "relationId", "delegationId"];
    if (Object.keys(input).some((key) => !keys.includes(key))) throw new ApiError("INVALID_REQUEST", "Unknown relation operation property", 400);
    if (input.operation === "relation_create") item.edges.push({ source: ref(input.source), target: ref(input.target), predicate: predicate(input.predicate) });
    else if (typeof input.relationId !== "string" || !/^rel_[A-Za-z0-9_-]+$/u.test(input.relationId)) throw new ApiError("INVALID_REQUEST", "Invalid relationId", 400);
    return item;
  }
  const { clientRef, semanticRelations, ...recordInput } = input;
  item.record = parseOperation({ ...recordInput, delegationId }, index);
  if (clientRef !== undefined) {
    if (input.operation !== "create" || typeof clientRef !== "string" || !REF.test(clientRef)) throw new ApiError("INVALID_REQUEST", "clientRef is valid only on create", 400);
    item.clientRef = clientRef;
  }
  if (input.operation === "create") {
    item.record.newRecordId = randomId("rec");
    if (semanticRelations !== undefined) {
      if (!Array.isArray(semanticRelations) || semanticRelations.length > 20) throw new ApiError("INVALID_REQUEST", "semanticRelations must contain at most 20 edges", 400);
      item.edges = semanticRelations.map((rawEdge) => {
        const edge = object(rawEdge);
        if (Object.keys(edge).some((key) => !["predicate", "target"].includes(key))) throw new ApiError("INVALID_REQUEST", "Unknown attached relation property", 400);
        return { source: { kind: "record", modelKey: item.record!.modelKey, recordId: item.record!.newRecordId },
          predicate: predicate(edge.predicate), target: ref(edge.target) };
      });
    }
    const tuples = item.edges.map(edge => JSON.stringify([edge.predicate, edge.target]));
    if (new Set(tuples).size !== tuples.length) throw new ApiError("INVALID_REQUEST", "Duplicate attached relation", 400);
  } else if (semanticRelations !== undefined) throw new ApiError("INVALID_REQUEST", "Attached relations require a create operation", 400);
  return item;
}
function samePrincipal(left: Principal, right: Principal): boolean {
  const la = left.actor ?? { type: left.type, id: left.id };
  const ra = right.actor ?? { type: right.type, id: right.id };
  return left.type === right.type && left.id === right.id && la.type === ra.type && la.id === ra.id && left.clientId === right.clientId;
}

/** Shared set-wise preparation; common path is one grouped D1 commit. */
export async function executeNativeModelBatch(env: Bindings, principal: Principal, spaceId: string,
  rawBody: unknown, headerDelegation: string | null = null) {
  const body = object(rawBody);
  if (Object.keys(body).some((key) => !["operations", "atomicConsistency", "delegationId"].includes(key))
    || !Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 20
    || body.atomicConsistency !== undefined && typeof body.atomicConsistency !== "boolean") {
    throw new ApiError("INVALID_REQUEST", "Batch requires 1-20 operations and optional atomicConsistency/delegationId", 400);
  }
  const atomic = body.atomicConsistency !== false;
  const selected = body.delegationId ?? headerDelegation;
  if (selected !== null && (typeof selected !== "string" || !/^dlg_[A-Za-z0-9_-]+$/u.test(selected))) throw new ApiError("INVALID_REQUEST", "Invalid batch delegationId", 400);
  const items: Item[] = body.operations.map((raw, index) => {
    try { return parseItem(raw, index, selected); }
    catch (error) { return { index, raw: {}, operation: "invalid", delegationId: selected,
      edges: [], decisions: [], requestIndexes: [], dependencies: new Set(), error: asError(error) }; }
  });
  const failAtomic = () => { if (atomic) { const error = items.find((item) => item.error)?.error; if (error) throw error; } };
  const refs = new Map<string, Item>();
  const newIds = new Map<string, Item>();
  const existingMutations = new Set<string>();
  for (const item of items) {
    if (item.error || !item.record) continue;
    if (item.record.newRecordId) newIds.set(item.record.newRecordId, item);
    if (item.clientRef) {
      if (refs.has(item.clientRef)) throw new ApiError("INVALID_REQUEST", "Duplicate clientRef", 400);
      refs.set(item.clientRef, item);
    }
    if (item.record.recordId) {
      if (existingMutations.has(item.record.recordId)) item.error = new ApiError("INVALID_REQUEST", "A record may be mutated once per batch", 400);
      existingMutations.add(item.record.recordId);
    }
  }
  // Load independent relation-delete tuples together, before endpoint authority.
  const deletes = items.filter((item) => !item.error && item.operation === "relation_delete");
  if (deletes.length) {
    const result = await env.DB.prepare(`SELECT id,source_model_key,source_record_id,predicate,target_model_key,target_record_id
      FROM semantic_relations WHERE space_id=? AND id IN (SELECT value FROM json_each(?))`)
      .bind(spaceId, JSON.stringify(deletes.map((item) => item.raw.relationId))).all<{
        id: string; source_model_key: string; source_record_id: string; predicate: SemanticRelationPredicate; target_model_key: string; target_record_id: string;
      }>();
    const rows = new Map(result.results.map((row) => [row.id, row]));
    for (const item of deletes) {
      const row = rows.get(String(item.raw.relationId));
      if (!row) item.error = new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
      else item.edges = [{ source: { kind: "record", modelKey: row.source_model_key, recordId: row.source_record_id },
        target: { kind: "record", modelKey: row.target_model_key, recordId: row.target_record_id }, predicate: row.predicate, id: row.id }];
    }
  }
  if (items.reduce((count, item) => count + item.edges.length, 0) > 20) throw new ApiError("INVALID_REQUEST", "Batch supports at most 20 relation actions/attachments", 400);
  const models = new Map<string, PublishedModel>();
  for (const item of items) {
    if (item.error) continue;
    try {
      for (const edge of item.edges) for (const endpoint of [edge.source, edge.target]) {
        if (endpoint.clientRef) {
          const create = refs.get(endpoint.clientRef);
          if (!create || create.record!.modelKey !== endpoint.modelKey) throw new ApiError("INVALID_REQUEST", "clientRef must identify a create of the stated model", 400);
          endpoint.recordId = create.record!.newRecordId; item.dependencies.add(create.index);
          delete endpoint.clientRef;
        }
        if (existingMutations.has(endpoint.recordId!)) throw new ApiError("INVALID_REQUEST", "Relation endpoints cannot also be updated/deleted in this batch", 400);
      }
      const keys = [item.record?.modelKey, ...item.edges.flatMap((edge) => [edge.source.modelKey, edge.target.modelKey])].filter((key): key is string => Boolean(key));
      for (const key of keys) {
        if (key.startsWith("ext_")) throw new ApiError(atomic ? "ATOMIC_CONSISTENCY_UNSUPPORTED" : "MODEL_OPERATION_UNSUPPORTED",
          "External endpoint execution requires Provider resolution; cross-store atomicity is unsupported", 400);
        if (!models.has(key)) {
          const published = await getRuntimeModel(env, key);
          if (published?.definition.origin === "external" && (atomic || item.record?.modelKey === key)) throw new ApiError(atomic ? "ATOMIC_CONSISTENCY_UNSUPPORTED" : "MODEL_OPERATION_UNSUPPORTED", "External CRUD requires the Provider executor; external edges require atomicConsistency=false", 422);
          const model = published ? await bindEndpointModel(env, spaceId, published) : null;
          if (!model) throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
          models.set(key, model);
        }
      }
      if (item.record) item.model = models.get(item.record.modelKey);
      for (const edge of item.edges) validateBatchSemanticRelation(models.get(edge.source.modelKey)!, models.get(edge.target.modelKey)!,
        { predicate: edge.predicate, target: { kind: "record", modelKey: edge.target.modelKey, recordId: edge.target.recordId! } });
    } catch (error) { item.error = asError(error); }
  }
  failAtomic();
  const requests: ModelAccessRequest[] = [];
  for (const item of items) {
    if (item.error) continue;
    const add = (modelKey: string, required: "read" | "write", id?: string) => {
      item.requestIndexes.push(requests.length);
      requests.push({ model: models.get(modelKey)!, required,
        selector: { delegationId: item.delegationId, recordId: id } });
    };
    if (item.record) add(item.record.modelKey, "write", item.record.recordId ?? item.record.newRecordId);
    for (const edge of item.edges) { add(edge.source.modelKey, "write", edge.source.recordId); add(edge.target.modelKey, "read", edge.target.recordId); }
  }
  // Without any resolvable operation there is no authorized Space in which to
  // persist request metadata. Reject the request before touching that boundary.
  if (!requests.length) throw items.find(item => item.error)!.error!;
  const evaluations = await evaluateModelAccessMany(env, principal, spaceId, requests);
  let execution = principal;
  for (const item of items) {
    if (item.error) continue;
    for (const index of item.requestIndexes) {
      const evaluation = evaluations[index]!;
      if (!evaluation.ok) { item.error = evaluation.error; break; }
      item.decisions.push(evaluation.decision);
    }
    if (!item.error && item.decisions.length) execution = item.decisions[0]!.principal;
  }
  if (items.every(item => item.error)) throw items[0]!.error!;
  if (items.some((item) => !item.error && item.decisions.some((decision) => !samePrincipal(execution, decision.principal)))) {
    throw new ApiError("DELEGATION_INVALID", "Batch must use one Execution Principal", 403);
  }
  if (atomic) {
    const seen = new Set<string>();
    for (const item of items) if (!item.error) for (const id of item.decisions[0]?.authority.singleUseDelegationIds ?? []) {
      if (seen.has(id)) item.error = new ApiError("DELEGATION_INVALID", "Single-use Delegation cannot authorize two batch actions", 403);
      seen.add(id);
    }
  }
  failAtomic();
  const groups = new Map<string, Set<string>>();
  const knownExternalGroups = new Map<string, Set<string>>();
  for (const item of items) {
    if (item.error) continue;
    const endpoints = item.edges.flatMap((edge) => [edge.source, edge.target]);
    if (item.record?.recordId) endpoints.push({ kind: "record", modelKey: item.record.modelKey, recordId: item.record.recordId });
    for (const endpoint of endpoints) if (!newIds.has(endpoint.recordId!)) {
      const collection = item.operation === "relation_delete" && models.get(endpoint.modelKey)?.definition.origin === "external" ? knownExternalGroups : groups;
      const ids = collection.get(endpoint.modelKey) ?? new Set<string>(); ids.add(endpoint.recordId!); collection.set(endpoint.modelKey, ids);
    }
  }
  const endpointDecisions = new Map<string, ModelAccessDecision>();
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!; const evaluation = evaluations[index]!;
    if (evaluation.ok && request.selector?.recordId) endpointDecisions.set(request.model.key + "\0" + request.selector.recordId, evaluation.decision);
  }
  const endpointFailures = new Map<string, ApiError>();
  const resources = await loadEndpointResources(env, spaceId,
    [...groups].map(([key, ids]) => ({ model: models.get(key)!, ids: [...ids] })), endpointDecisions, false, endpointFailures);
  for (const item of items) if (!item.error) {
    const failure = item.edges.flatMap(edge => [edge.source, edge.target])
      .map(endpoint => endpointFailures.get(endpoint.modelKey + "\0" + endpoint.recordId)).find(Boolean);
    if (failure) item.error = failure;
  }
  if (knownExternalGroups.size) {
    const known = await loadEndpointResources(env, spaceId, [...knownExternalGroups].map(([key, ids]) => ({ model: models.get(key)!, ids: [...ids] })), endpointDecisions, true);
    for (const [id, resource] of known) if (!resources.has(id)) resources.set(id, resource);
  }
  const temporal = items.some((item) => !item.error && item.record?.operation === "create" && hasTemporalCapability(item.model!))
    ? await loadSpaceTemporalContext(env, spaceId) : undefined;
  const correlationId = randomId(atomic ? "cgs" : "blk");
  const timestamp = new Date().toISOString();
  await prepareRecurrenceMutations(env, execution, spaceId, items.filter(item => !item.error && item.record && item.record.operation !== "delete").map(item => ({
    model: item.model!, recordId: item.record!.recordId ?? item.record!.newRecordId,
    previous: item.record!.recordId ? resources.get(item.record!.recordId) : undefined,
    data: { ...(item.record!.recordId ? resources.get(item.record!.recordId)?.data : {}), ...item.record!.data },
    attribution: { delegationId: item.decisions[0]?.authority.delegationId },
  })));
  for (const item of items) {
    if (item.error || !item.record) continue;
    try {
      [item.prepared] = await prepareOperations(env, execution, spaceId, [item.record], [item.model!], [item.decisions[0]!], resources, temporal);
      const entry = item.prepared!;
      const attribution = { delegationId: entry.decision.authority.delegationId, delegationChain: entry.decision.authority.delegationChain,
        ...(atomic ? { changeSetId: correlationId } : { bulkId: correlationId }) };
      if (item.record.operation === "create") item.plan = await planCreateGenericMutation(env, execution, spaceId, item.model!, entry.preparedCreate!, entry.extension, attribution, timestamp, item.record.newRecordId);
      else if (item.record.operation === "update") item.plan = await planUpdateGenericMutation(env, execution, spaceId, item.model!, entry.previous!, item.record.version ?? entry.previous!.version, entry.preparedUpdate!, "client", undefined, undefined, attribution, timestamp);
      else item.plan = planDeleteGenericMutation(env, execution, spaceId, item.model!, entry.previous!, item.record.version ?? entry.previous!.version, attribution, timestamp);
      if (item.plan.resource) resources.set(item.plan.resource.id, item.plan.resource);
    } catch (error) { item.error = asError(error); }
  }
  const recordItems = items.filter((item) => !item.error && item.prepared);
  const relationErrors = await validateRelationProjectionGroups(env, spaceId, recordItems.map((item) =>
    [...(item.prepared!.preparedCreate?.relations ?? []), ...(item.prepared!.preparedUpdate?.relations ?? [])]));
  recordItems.forEach((item, index) => { if (relationErrors[index]) item.error = relationErrors[index]!; });
  const fileErrors = await validateFileProjectionGroups(env, spaceId, recordItems.map((item) =>
    [...(item.prepared!.preparedCreate?.files ?? []), ...(item.prepared!.preparedUpdate?.files ?? [])]));
  fileErrors.forEach((error, index) => { if (error) recordItems[index]!.error = error; });
  // Propagate failed create references to a fixed point, including forward refs.
  const propagate = () => { for (let pass = 0; pass < items.length; pass += 1) for (const item of items) {
    if (!item.error && [...item.dependencies].some((index) => items[index]!.error)) item.error = new ApiError("BATCH_DEPENDENCY_FAILED", "Referenced create failed", 400);
  } };
  propagate();
  for (const item of items) {
    if (item.error) continue;
    try {
      let offset = item.record ? 1 : 0;
      for (const edge of item.edges) {
        const sourceDecision = item.decisions[offset++]!; const targetDecision = item.decisions[offset++]!;
        validateBatchSemanticRelationAuthority(sourceDecision, targetDecision);
        const source = resources.get(edge.source.recordId!); const target = resources.get(edge.target.recordId!);
        if (!source || !target || source.modelKey !== edge.source.modelKey || target.modelKey !== edge.target.modelKey || (item.operation !== "relation_delete" && ((models.get(edge.source.modelKey)!.definition.origin === "external" && !source.externalView) || (models.get(edge.target.modelKey)!.definition.origin === "external" && !target.externalView)))) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
        await requireModelPolicy(env, execution, spaceId, models.get(edge.source.modelKey)!, "update", source, undefined, sourceDecision.policyIdentity);
        await requireModelPolicy(env, execution, spaceId, models.get(edge.target.modelKey)!, "read", target, undefined, targetDecision.policyIdentity);
      }
    } catch (error) { item.error = asError(error); }
  }
  propagate(); failAtomic();
  const actor = execution.actor ?? { type: execution.type, id: execution.id };
  const insert = atomic
    ? env.DB.prepare(`INSERT INTO resource_change_sets(id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(correlationId, spaceId, execution.clientId, execution.type, execution.id, actor.type, actor.id, items.length, timestamp)
    : env.DB.prepare(`INSERT INTO resource_bulk_requests(id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(correlationId, spaceId, execution.clientId, execution.type, execution.id, actor.type, actor.id, items.length, timestamp);
  const finalize = atomic
    ? env.DB.prepare("UPDATE resource_change_sets SET committed_at=? WHERE id=?").bind(timestamp, correlationId)
    : env.DB.prepare(`UPDATE resource_bulk_requests SET completed_at=?,
      succeeded_count=(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?) + (SELECT COUNT(*) FROM semantic_relation_batch_receipts WHERE bulk_id=?),
      failed_count=operation_count-(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?)-(SELECT COUNT(*) FROM semantic_relation_batch_receipts WHERE bulk_id=?) WHERE id=?`)
      .bind(timestamp, correlationId, correlationId, correlationId, correlationId, correlationId);
  for (const item of items) if (!item.error) {
    item.statements = [...(item.plan?.statements ?? [])];
    for (let index = 0; index < item.edges.length; index += 1) {
      const decision = item.decisions[(item.record ? 1 : 0) + index * 2]!;
      item.statements.push(...edgeStatements(env, spaceId, item, item.edges[index]!, decision, execution, correlationId, atomic, timestamp));
    }
  }
  const statements = [insert];
  // Atomic commit creates all records first, supporting forward refs and cycles.
  for (const item of items) if (!item.error) statements.push(...(item.plan?.statements ?? []));
  for (const item of items) if (!item.error) {
    item.resultOffset = statements.length + item.statements!.length - (item.plan?.statements.length ?? 0) - 1;
    statements.push(...item.statements!.slice(item.plan?.statements.length ?? 0));
    if (item.record) {
      item.resultOffset = statements.length;
      statements.push(env.DB.prepare("SELECT id FROM resource_changes WHERE id=?").bind(item.plan!.changeId));
    }
  }
  statements.push(finalize);
  try {
    const results = await env.DB.batch(statements);
    for (const item of items) if (!item.error) {
      const result = results[item.resultOffset!]?.results?.[0] as { id?: string } | undefined;
      if (!result) item.error = new ApiError("VERSION_CONFLICT", "Item changed before commit", 409);
      else item.result = item.record ? { recordId: item.plan!.resource?.id ?? item.record.recordId,
        version: item.plan!.resource?.version ?? item.prepared!.previous!.version + 1,
        ...(item.edges.length ? { semanticRelationIds: item.edges.map((edge) => edge.id) } : {}) } : { relationId: result.id };
    }
  } catch (error) {
    const failure = asError(error);
    if (atomic) throw failure;
    // Only commit-time contention uses this bounded <=20-item slow path. Common
    // validation failures were removed before the grouped commit, not N calls.
    await env.DB.batch([insert]);
    const pending = items.filter((item) => !item.error);
    while (pending.length) {
      const ready = pending.findIndex((item) => [...item.dependencies].every((index) => !pending.includes(items[index]!)));
      if (ready < 0) { for (const item of pending) item.error = new ApiError("BATCH_DEPENDENCY_FAILED", "Cyclic non-atomic dependency cannot be replayed", 400); break; }
      const [item] = pending.splice(ready, 1); propagate(); if (item!.error) continue;
      try {
        const replay = [...item!.statements!];
        if (item!.record) replay.push(env.DB.prepare("SELECT id FROM resource_changes WHERE id=?").bind(item!.plan!.changeId));
        const results = await env.DB.batch(replay);
        const result = results[results.length - 1]?.results?.[0] as { id?: string } | undefined;
        if (!result) throw new ApiError("VERSION_CONFLICT", "Item changed before commit", 409);
        item!.result = item!.record ? { recordId: item!.plan!.resource?.id ?? item!.record.recordId,
          version: item!.plan!.resource?.version ?? item!.prepared!.previous!.version + 1,
          ...(item!.edges.length ? { semanticRelationIds: item!.edges.map((edge) => edge.id) } : {}) } : { relationId: result.id };
      } catch (itemError) { item!.error = asError(itemError); }
    }
    await env.DB.batch([finalize]);
  }
  return { ...(atomic ? { changeSetId: correlationId } : { bulkId: correlationId }), atomicConsistency: atomic,
    items: items.map((item) => item.error ? { index: item.index, operation: item.operation, modelKey: item.record?.modelKey ?? null,
      status: "failed", error: { code: item.error.code, message: item.error.message, status: item.error.status } }
      : { index: item.index, operation: item.operation, modelKey: item.record?.modelKey ?? null, status: "succeeded", ...item.result }) };
}

function edgeStatements(env: Bindings, spaceId: string, item: Item, edge: Edge, decision: ModelAccessDecision,
  principal: Principal, correlationId: string, atomic: boolean, timestamp: string): D1PreparedStatement[] {
  const createdId = edge.id ?? randomId("rel"); const changeId = randomId("chg");
  edge.id = createdId;
  const actor = principal.actor ?? { type: principal.type, id: principal.id };
  const tuple = [spaceId, edge.source.modelKey, edge.source.recordId, edge.predicate, edge.target.modelKey, edge.target.recordId];
  const where = "space_id=? AND source_model_key=? AND source_record_id=? AND predicate=? AND target_model_key=? AND target_record_id=?";
  const deleting = item.operation === "relation_delete";
  const available = ` AND NOT EXISTS(SELECT 1 FROM delegations d WHERE d.id IN (SELECT value FROM json_each(?))
    AND (d.revoked_at IS NOT NULL OR (d.expires_at IS NOT NULL AND julianday(d.expires_at)<=julianday('now'))
      OR (d.consumed_at IS NOT NULL AND d.consumed_by_change_id<>?)))`;
  const availabilityArgs = [JSON.stringify(decision.authority.delegationChain), item.plan?.changeId ?? changeId];
  const statements: D1PreparedStatement[] = [];
  if (!deleting) statements.push(env.DB.prepare(`INSERT OR IGNORE INTO semantic_relations(id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(createdId, ...tuple, timestamp));
  statements.push(env.DB.prepare(`INSERT INTO semantic_relation_changes(id,relation_id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,
    operation,principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,source_resource_change_id,change_set_id,bulk_id,occurred_at)
    SELECT ?,id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,?,?,?,?,?,?,?,?,?,?,?
    FROM semantic_relations WHERE ${where} AND id=?`).bind(changeId, deleting ? "delete" : "create", principal.type, principal.id, actor.type, actor.id,
      principal.clientId, decision.authority.delegationId, item.plan?.changeId ?? null, atomic ? correlationId : null, atomic ? null : correlationId, timestamp, ...tuple, createdId));
  if (!item.record) {
    statements.push(...decision.authority.delegationChain.map((id, position) => env.DB.prepare(`INSERT INTO semantic_relation_change_delegations(change_id,delegation_id,chain_position)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM semantic_relation_changes WHERE id=?)`).bind(changeId, id, position, changeId)));
    statements.push(env.DB.prepare(`INSERT INTO semantic_relation_batch_receipts(change_set_id,bulk_id,operation_index,relation_id)
      SELECT ?,?,?,id FROM semantic_relations WHERE ${where}${deleting ? " AND id=?" : ""}${available}`)
      .bind(atomic ? correlationId : null, atomic ? null : correlationId, item.index, ...tuple, ...(deleting ? [createdId] : []), ...availabilityArgs));
  }
  if (deleting) statements.push(env.DB.prepare("DELETE FROM semantic_relations WHERE space_id=? AND id=? AND EXISTS(SELECT 1 FROM semantic_relation_changes WHERE id=?)").bind(spaceId, createdId, changeId));
  statements.push(deleting
    ? env.DB.prepare("SELECT relation_id id FROM semantic_relation_changes WHERE id=?").bind(changeId)
    : env.DB.prepare(`SELECT id FROM semantic_relations WHERE ${where}${available}`).bind(...tuple, ...availabilityArgs));
  return statements;
}

import type { Bindings, Principal } from "./env";
import type { GenericResource } from "./generic-resource";
import { ApiError } from "./http";
import {
  consumeSingleUseRead,
  evaluateModelAccessMany,
  requireModelAccessMany,
  type ModelAccessDecision,
  type ModelAccessEvaluation,
  type ModelAccessRequest,
} from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import {
  isSemanticRelationPredicate,
  semanticRelationAllowsEndpoints,
  type SemanticRelationPredicate,
} from "./semantic-relation-definition";
import { getTypedResourcesByModels } from "./typed-resource-batch";

export type SemanticEntityRef = {
  kind: "record";
  modelKey: string;
  recordId: string;
};

export type SemanticRelation = {
  id: string;
  spaceId: string;
  source: SemanticEntityRef;
  predicate: SemanticRelationPredicate;
  target: SemanticEntityRef;
  createdAt: string;
  sourceRecord?: Record<string, unknown>;
  targetRecord?: Record<string, unknown>;
};

export type SemanticRelationCreateInput = {
  source: SemanticEntityRef;
  predicate: SemanticRelationPredicate;
  target: SemanticEntityRef;
};

export type SemanticRelationQuery = {
  source?: SemanticEntityRef;
  target?: SemanticEntityRef;
  predicate?: SemanticRelationPredicate;
  limit: number;
  cursor?: string;
  delegationId?: string | null;
  hydrate?: "source" | "target" | "both";
};

type SemanticRelationRow = {
  id: string;
  space_id: string;
  source_model_key: string;
  source_record_id: string;
  predicate: string;
  target_model_key: string;
  target_record_id: string;
  created_at: string;
};

type RelationMutationContext = {
  sourceModel: PublishedModel;
  targetModel: PublishedModel;
  sourceResource: GenericResource;
  targetResource: GenericResource;
  sourceDecision: ModelAccessDecision;
  targetDecision: ModelAccessDecision;
  principal: Principal;
};

const MODEL_KEY = /^[a-z][a-z0-9_]{1,62}$/u;
const RECORD_ID = /^rec_[A-Za-z0-9_-]+$/u;
const RELATION_ID = /^rel_[A-Za-z0-9_-]+$/u;
const MAX_QUERY_LIMIT = 100;
const MAX_VISIBILITY_SCAN = 200;

const relationId = () => `rel_${crypto.randomUUID().replaceAll("-", "")}`;
const changeId = () => `chg_${crypto.randomUUID().replaceAll("-", "")}`;

function actor(principal: Principal) {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

function entityRef(modelKey: string, recordId: string): SemanticEntityRef {
  return { kind: "record", modelKey, recordId };
}

function relationFromRow(row: SemanticRelationRow): SemanticRelation {
  return {
    id: row.id,
    spaceId: row.space_id,
    source: entityRef(row.source_model_key, row.source_record_id),
    predicate: row.predicate as SemanticRelationPredicate,
    target: entityRef(row.target_model_key, row.target_record_id),
    createdAt: row.created_at,
  };
}

function validateRef(ref: SemanticEntityRef, name: "source" | "target"): void {
  if (ref.kind !== "record"
      || !MODEL_KEY.test(ref.modelKey)
      || !RECORD_ID.test(ref.recordId)) {
    throw new ApiError("INVALID_REQUEST", `${name} must be a valid record entity_ref`, 400);
  }
}

function validateCreateInput(input: SemanticRelationCreateInput): void {
  validateRef(input.source, "source");
  validateRef(input.target, "target");
  if (!isSemanticRelationPredicate(input.predicate)) {
    throw new ApiError("INVALID_REQUEST", "predicate is not registered by LifeSpace", 400);
  }
}

function relationDeclaredBySource(model: PublishedModel, predicate: SemanticRelationPredicate): boolean {
  return model.definition.semanticRelations?.outgoing?.includes(predicate) === true;
}

async function modelOr404(env: Bindings, key: string): Promise<PublishedModel> {
  const model = await getRuntimeModel(env, key);
  if (!model) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  return model;
}

function endpointRequests(
  sourceModel: PublishedModel,
  targetModel: PublishedModel,
  sourceRecordId: string,
  targetRecordId: string,
  delegationId?: string | null,
): ModelAccessRequest[] {
  return [
    {
      model: sourceModel,
      required: "write",
      selector: { delegationId: delegationId ?? null, recordId: sourceRecordId },
    },
    {
      model: targetModel,
      required: "read",
      selector: { delegationId: delegationId ?? null, recordId: targetRecordId },
    },
  ];
}

function sameExecutionPrincipal(left: Principal, right: Principal): boolean {
  return left.type === right.type
    && left.id === right.id
    && left.actor?.type === right.actor?.type
    && left.actor?.id === right.actor?.id;
}

function normalizedChain(decision: ModelAccessDecision): string[] {
  return [...decision.authority.delegationChain];
}

function mutationDelegation(decisions: readonly ModelAccessDecision[]): {
  delegationId: string | null;
  chain: string[];
} {
  const ids = [...new Set(decisions.map((decision) => decision.authority.delegationId).filter(Boolean))] as string[];
  if (ids.length > 1) {
    throw new ApiError("DELEGATION_INVALID", "One Semantic Relation mutation must use one Delegation leaf", 403);
  }
  const chains = decisions.map(normalizedChain).filter((chain) => chain.length);
  if (chains.length > 1 && chains.some((chain) => JSON.stringify(chain) !== JSON.stringify(chains[0]))) {
    throw new ApiError("DELEGATION_INVALID", "Semantic Relation endpoints resolved through different Delegation chains", 403);
  }
  return { delegationId: ids[0] ?? null, chain: chains[0] ?? [] };
}

async function mutationContext(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  input: SemanticRelationCreateInput,
  delegationId?: string | null,
): Promise<RelationMutationContext> {
  validateCreateInput(input);
  const [sourceModel, targetModel] = await Promise.all([
    modelOr404(env, input.source.modelKey),
    modelOr404(env, input.target.modelKey),
  ]);
  if (!relationDeclaredBySource(sourceModel, input.predicate)
      || !semanticRelationAllowsEndpoints(input.predicate, sourceModel.key, targetModel.key)) {
    throw new ApiError(
      "SEMANTIC_RELATION_NOT_ALLOWED",
      `${sourceModel.key} does not declare ${input.predicate} to ${targetModel.key}`,
      400,
    );
  }

  const decisions = await requireModelAccessMany(
    env,
    principal,
    spaceId,
    endpointRequests(
      sourceModel,
      targetModel,
      input.source.recordId,
      input.target.recordId,
      delegationId,
    ),
  );
  const [sourceDecision, targetDecision] = decisions;
  if (!sourceDecision || !targetDecision || !sameExecutionPrincipal(sourceDecision.principal, targetDecision.principal)) {
    throw new ApiError("DELEGATION_INVALID", "Semantic Relation endpoints must resolve to one Execution Principal", 403);
  }

  const resources = await getTypedResourcesByModels(env, spaceId, [
    { model: sourceModel, ids: [input.source.recordId] },
    { model: targetModel, ids: [input.target.recordId] },
  ]);
  const sourceResource = resources.get(input.source.recordId) as GenericResource | undefined;
  const targetResource = resources.get(input.target.recordId) as GenericResource | undefined;
  if (!sourceResource || !targetResource) {
    throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  }

  await Promise.all([
    requireModelPolicy(
      env,
      sourceDecision.principal,
      spaceId,
      sourceModel,
      "update",
      sourceResource,
      undefined,
      sourceDecision.policyIdentity,
    ),
    requireModelPolicy(
      env,
      targetDecision.principal,
      spaceId,
      targetModel,
      "read",
      targetResource,
      undefined,
      targetDecision.policyIdentity,
    ),
  ]);

  return {
    sourceModel,
    targetModel,
    sourceResource,
    targetResource,
    sourceDecision,
    targetDecision,
    principal: sourceDecision.principal,
  };
}

function relationChangeStatement(
  env: Bindings,
  relationChangeId: string,
  relation: SemanticRelationCreateInput,
  spaceId: string,
  operation: "create" | "delete",
  principal: Principal,
  delegationId: string | null,
  timestamp: string,
  onlyRelationId?: string,
): D1PreparedStatement {
  const executedBy = actor(principal);
  const relationFilter = onlyRelationId ? " AND id=?" : "";
  return env.DB.prepare(`INSERT INTO semantic_relation_changes(
      id,relation_id,space_id,source_model_key,source_record_id,predicate,
      target_model_key,target_record_id,operation,principal_type,principal_id,
      actor_type,actor_id,application_id,delegation_id,occurred_at
    )
    SELECT ?,id,space_id,source_model_key,source_record_id,predicate,
      target_model_key,target_record_id,?,?,?,?,?,?,?,?
    FROM semantic_relations
    WHERE space_id=? AND source_model_key=? AND source_record_id=? AND predicate=?
      AND target_model_key=? AND target_record_id=?${relationFilter}`).bind(
    relationChangeId,
    operation,
    principal.type,
    principal.id,
    executedBy.type,
    executedBy.id,
    principal.clientId,
    delegationId,
    timestamp,
    spaceId,
    relation.source.modelKey,
    relation.source.recordId,
    relation.predicate,
    relation.target.modelKey,
    relation.target.recordId,
    ...(onlyRelationId ? [onlyRelationId] : []),
  );
}

function delegationEvidenceStatements(
  env: Bindings,
  relationChangeId: string,
  chain: readonly string[],
): D1PreparedStatement[] {
  return chain.map((delegationId, chainPosition) => env.DB.prepare(`INSERT INTO semantic_relation_change_delegations(
      change_id,delegation_id,chain_position
    ) SELECT ?,?,? WHERE EXISTS(
      SELECT 1 FROM semantic_relation_changes WHERE id=?
    )`).bind(relationChangeId, delegationId, chainPosition, relationChangeId));
}

export async function createSemanticRelation(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  input: SemanticRelationCreateInput,
  delegationId?: string | null,
): Promise<SemanticRelation> {
  const resolved = await mutationContext(env, principal, spaceId, input, delegationId);
  const attribution = mutationDelegation([resolved.sourceDecision, resolved.targetDecision]);
  const id = relationId();
  const relationChangeId = changeId();
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT OR IGNORE INTO semantic_relations(
      id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).bind(
      id,
      spaceId,
      input.source.modelKey,
      input.source.recordId,
      input.predicate,
      input.target.modelKey,
      input.target.recordId,
      timestamp,
    ),
    relationChangeStatement(
      env,
      relationChangeId,
      input,
      spaceId,
      "create",
      resolved.principal,
      attribution.delegationId,
      timestamp,
      id,
    ),
    ...delegationEvidenceStatements(env, relationChangeId, attribution.chain),
    env.DB.prepare(`SELECT id,space_id,source_model_key,source_record_id,predicate,
        target_model_key,target_record_id,created_at
      FROM semantic_relations
      WHERE space_id=? AND source_model_key=? AND source_record_id=? AND predicate=?
        AND target_model_key=? AND target_record_id=?`).bind(
      spaceId,
      input.source.modelKey,
      input.source.recordId,
      input.predicate,
      input.target.modelKey,
      input.target.recordId,
    ),
  ];

  const results = await env.DB.batch<SemanticRelationRow>(statements);
  const row = (results[results.length - 1]?.results ?? [])[0] as SemanticRelationRow | undefined;
  if (!row) throw new ApiError("INTERNAL_ERROR", "Semantic Relation commit did not produce a readable edge", 500);
  return relationFromRow(row);
}

async function relationRowById(
  env: Bindings,
  spaceId: string,
  id: string,
): Promise<SemanticRelationRow | null> {
  if (!RELATION_ID.test(id)) return null;
  return env.DB.prepare(`SELECT id,space_id,source_model_key,source_record_id,predicate,
      target_model_key,target_record_id,created_at
    FROM semantic_relations WHERE space_id=? AND id=?`).bind(spaceId, id).first<SemanticRelationRow>();
}

export async function deleteSemanticRelation(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  id: string,
  delegationId?: string | null,
): Promise<void> {
  const row = await relationRowById(env, spaceId, id);
  if (!row) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  const relation = relationFromRow(row);
  const input: SemanticRelationCreateInput = {
    source: relation.source,
    predicate: relation.predicate,
    target: relation.target,
  };
  const resolved = await mutationContext(env, principal, spaceId, input, delegationId);
  const attribution = mutationDelegation([resolved.sourceDecision, resolved.targetDecision]);
  const relationChangeId = changeId();
  const timestamp = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    relationChangeStatement(
      env,
      relationChangeId,
      input,
      spaceId,
      "delete",
      resolved.principal,
      attribution.delegationId,
      timestamp,
      id,
    ),
    ...delegationEvidenceStatements(env, relationChangeId, attribution.chain),
    env.DB.prepare(`DELETE FROM semantic_relations
      WHERE id=? AND space_id=? AND EXISTS(
        SELECT 1 FROM semantic_relation_changes WHERE id=?
      )`).bind(id, spaceId, relationChangeId),
  ];
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
}

function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || !RELATION_ID.test(parsed.id)) {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ApiError("INVALID_QUERY", "cursor is invalid", 400);
  }
}

function encodeCursor(row: SemanticRelationRow): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id }));
}

function recordView(resource: GenericResource): Record<string, unknown> {
  return {
    id: resource.id,
    spaceId: resource.spaceId,
    modelKey: resource.modelKey,
    modelVersion: resource.modelVersion,
    ...resource.data,
    version: resource.version,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

function relationWithHydration(
  row: SemanticRelationRow,
  resources: Map<string, GenericResource>,
  hydrate: SemanticRelationQuery["hydrate"],
): SemanticRelation {
  const relation = relationFromRow(row);
  if ((hydrate === "source" || hydrate === "both") && resources.has(row.source_record_id)) {
    relation.sourceRecord = recordView(resources.get(row.source_record_id)!);
  }
  if ((hydrate === "target" || hydrate === "both") && resources.has(row.target_record_id)) {
    relation.targetRecord = recordView(resources.get(row.target_record_id)!);
  }
  return relation;
}

function endpointKey(modelKey: string, recordId: string): string {
  return `${modelKey}\u0000${recordId}`;
}

function policyVisible(
  error: unknown,
): boolean {
  return !(error instanceof ApiError && [403, 404].includes(error.status));
}

async function visibleCandidates(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  rows: readonly SemanticRelationRow[],
  delegationId: string | null | undefined,
  hydrate: SemanticRelationQuery["hydrate"],
): Promise<{ rows: SemanticRelationRow[]; resources: Map<string, GenericResource>; decisions: ModelAccessDecision[] }> {
  const modelKeys = [...new Set(rows.flatMap((row) => [row.source_model_key, row.target_model_key]))];
  const resolvedModels = await Promise.all(modelKeys.map(async (key) => [key, await getRuntimeModel(env, key)] as const));
  const models = new Map(resolvedModels.filter((entry): entry is readonly [string, PublishedModel] => Boolean(entry[1])));

  const endpoints = new Map<string, { model: PublishedModel; recordId: string }>();
  for (const row of rows) {
    const sourceModel = models.get(row.source_model_key);
    const targetModel = models.get(row.target_model_key);
    if (sourceModel) endpoints.set(endpointKey(sourceModel.key, row.source_record_id), { model: sourceModel, recordId: row.source_record_id });
    if (targetModel) endpoints.set(endpointKey(targetModel.key, row.target_record_id), { model: targetModel, recordId: row.target_record_id });
  }

  const endpointEntries = [...endpoints.entries()];
  const evaluations = await evaluateModelAccessMany(
    env,
    principal,
    spaceId,
    endpointEntries.map(([, endpoint]) => ({
      model: endpoint.model,
      required: "read" as const,
      selector: { delegationId: delegationId ?? null, recordId: endpoint.recordId },
    })),
  );
  const evaluationByEndpoint = new Map<string, ModelAccessEvaluation>();
  endpointEntries.forEach(([key], index) => evaluationByEndpoint.set(key, evaluations[index]!));

  const needsResource = new Map<string, { model: PublishedModel; ids: string[] }>();
  endpointEntries.forEach(([key, endpoint]) => {
    const evaluation = evaluationByEndpoint.get(key);
    if (!evaluation?.ok) return;
    const needsPolicy = Boolean(endpoint.model.definition.policies?.read);
    const needsHydration = hydrate === "both"
      || (hydrate === "source" && rows.some((row) => row.source_model_key === endpoint.model.key && row.source_record_id === endpoint.recordId))
      || (hydrate === "target" && rows.some((row) => row.target_model_key === endpoint.model.key && row.target_record_id === endpoint.recordId));
    if (!needsPolicy && !needsHydration) return;
    const group = needsResource.get(endpoint.model.key) ?? { model: endpoint.model, ids: [] };
    group.ids.push(endpoint.recordId);
    needsResource.set(endpoint.model.key, group);
  });

  const loaded = await getTypedResourcesByModels(env, spaceId, [...needsResource.values()]);
  const resources = new Map<string, GenericResource>();
  for (const [id, resource] of loaded) resources.set(id, resource as GenericResource);
  const visibleEndpoints = new Map<string, boolean>();
  const visibleDecisions: ModelAccessDecision[] = [];

  for (const [key, endpoint] of endpointEntries) {
    const evaluation = evaluationByEndpoint.get(key);
    if (!evaluation?.ok) {
      visibleEndpoints.set(key, false);
      continue;
    }
    const decision = evaluation.decision;
    if (endpoint.model.definition.policies?.read) {
      const resource = resources.get(endpoint.recordId);
      if (!resource) {
        visibleEndpoints.set(key, false);
        continue;
      }
      try {
        await requireModelPolicy(
          env,
          decision.principal,
          spaceId,
          endpoint.model,
          "read",
          resource,
          undefined,
          decision.policyIdentity,
        );
      } catch (error) {
        if (!policyVisible(error)) {
          visibleEndpoints.set(key, false);
          continue;
        }
        throw error;
      }
    }
    visibleEndpoints.set(key, true);
    visibleDecisions.push(decision);
  }

  return {
    rows: rows.filter((row) =>
      visibleEndpoints.get(endpointKey(row.source_model_key, row.source_record_id)) === true
      && visibleEndpoints.get(endpointKey(row.target_model_key, row.target_record_id)) === true
    ),
    resources,
    decisions: visibleDecisions,
  };
}

export async function querySemanticRelations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  query: SemanticRelationQuery,
): Promise<{ items: SemanticRelation[]; nextCursor: string | null }> {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_QUERY_LIMIT) {
    throw new ApiError("INVALID_QUERY", `limit must be between 1 and ${MAX_QUERY_LIMIT}`, 400);
  }
  if (query.source) validateRef(query.source, "source");
  if (query.target) validateRef(query.target, "target");
  if (query.predicate && !isSemanticRelationPredicate(query.predicate)) {
    throw new ApiError("INVALID_QUERY", "predicate is not registered by LifeSpace", 400);
  }
  const cursor = decodeCursor(query.cursor);
  const where = ["space_id=?"];
  const args: unknown[] = [spaceId];
  if (query.source) {
    where.push("source_model_key=?", "source_record_id=?");
    args.push(query.source.modelKey, query.source.recordId);
  }
  if (query.target) {
    where.push("target_model_key=?", "target_record_id=?");
    args.push(query.target.modelKey, query.target.recordId);
  }
  if (query.predicate) {
    where.push("predicate=?");
    args.push(query.predicate);
  }
  if (cursor) {
    where.push("(created_at<? OR (created_at=? AND id<?))");
    args.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const scanLimit = Math.min(MAX_VISIBILITY_SCAN, Math.max(query.limit * 4, 40));
  const result = await env.DB.prepare(`SELECT id,space_id,source_model_key,source_record_id,predicate,
      target_model_key,target_record_id,created_at
    FROM semantic_relations
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC,id DESC
    LIMIT ?`).bind(...args, scanLimit).all<SemanticRelationRow>();
  const candidates = result.results;
  if (!candidates.length) return { items: [], nextCursor: null };

  const visible = await visibleCandidates(
    env,
    principal,
    spaceId,
    candidates,
    query.delegationId,
    query.hydrate,
  );
  const page = visible.rows.slice(0, query.limit);
  const scannedTo = candidates[candidates.length - 1]!;
  const hasMoreCandidates = candidates.length === scanLimit || visible.rows.length > query.limit;
  const nextCursor = hasMoreCandidates ? encodeCursor(scannedTo) : null;

  if (page.length && visible.decisions.length) {
    // One request carries one selected Delegation leaf. Consuming one successful
    // read decision therefore consumes the shared single-use chain exactly once.
    await consumeSingleUseRead(env, visible.decisions[0]!);
  }

  return {
    items: page.map((row) => relationWithHydration(row, visible.resources, query.hydrate)),
    nextCursor,
  };
}

export async function getSemanticRelation(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  id: string,
  delegationId?: string | null,
  hydrate?: SemanticRelationQuery["hydrate"],
): Promise<SemanticRelation | null> {
  const row = await relationRowById(env, spaceId, id);
  if (!row) return null;
  const visible = await visibleCandidates(env, principal, spaceId, [row], delegationId, hydrate);
  if (!visible.rows.length) return null;
  if (visible.decisions.length) await consumeSingleUseRead(env, visible.decisions[0]!);
  return relationWithHydration(row, visible.resources, hydrate);
}

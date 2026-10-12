import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { ModelAccessDecision } from "./model-authorization";
import type { PublishedModel } from "./model-registry";
import type { GenericResource } from "./generic-resource";
import {
  semanticRelationAllowsEndpoints,
  type SemanticRelationPredicate,
} from "./semantic-relation-definition";
import type { SemanticEntityRef } from "./semantic-relation";

export type BatchSemanticRelationSpec = {
  predicate: SemanticRelationPredicate;
  target: SemanticEntityRef;
};

export type PreparedBatchSemanticRelation = {
  spec: BatchSemanticRelationSpec;
  targetModel: PublishedModel;
  targetResource: GenericResource;
  targetDecision: ModelAccessDecision;
};

export type BatchSemanticRelationPlan = {
  statements: D1PreparedStatement[];
  relationIds: string[];
};

function relationId(): string {
  return `rel_${crypto.randomUUID().replaceAll("-", "")}`;
}

function changeId(): string {
  return `chg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function operationActor(principal: Principal) {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

function sameExecutionPrincipal(left: ModelAccessDecision, right: ModelAccessDecision): boolean {
  return left.principal.type === right.principal.type
    && left.principal.id === right.principal.id
    && left.principal.actor?.type === right.principal.actor?.type
    && left.principal.actor?.id === right.principal.actor?.id;
}

function sameDelegationChain(left: ModelAccessDecision, right: ModelAccessDecision): boolean {
  return left.authority.delegationId === right.authority.delegationId
    && JSON.stringify(left.authority.delegationChain) === JSON.stringify(right.authority.delegationChain);
}

export function validateBatchSemanticRelation(
  sourceModel: PublishedModel,
  targetModel: PublishedModel,
  spec: BatchSemanticRelationSpec,
): void {
  if (!sourceModel.definition.semanticRelations?.outgoing?.includes(spec.predicate)
      || !semanticRelationAllowsEndpoints(spec.predicate, sourceModel.key, targetModel.key)) {
    throw new ApiError(
      "SEMANTIC_RELATION_NOT_ALLOWED",
      `${sourceModel.key} does not declare ${spec.predicate} to ${targetModel.key}`,
      400,
    );
  }
}

export function validateBatchSemanticRelationAuthority(
  sourceDecision: ModelAccessDecision,
  targetDecision: ModelAccessDecision,
): void {
  if (!sameExecutionPrincipal(sourceDecision, targetDecision)) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "Semantic Relation target must resolve to the Batch Execution Principal",
      403,
    );
  }
  if (!sameDelegationChain(sourceDecision, targetDecision)) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "Semantic Relation source write and target read must use the same Delegation chain",
      403,
    );
  }
}

export function planBatchSemanticRelations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  sourceModel: PublishedModel,
  sourceResource: GenericResource,
  sourceChangeId: string,
  sourceDecision: ModelAccessDecision,
  relations: readonly PreparedBatchSemanticRelation[],
  changeSetId: string,
  timestamp: string,
): BatchSemanticRelationPlan {
  const statements: D1PreparedStatement[] = [];
  const relationIds: string[] = [];
  const executedBy = operationActor(principal);

  for (const relation of relations) {
    validateBatchSemanticRelation(sourceModel, relation.targetModel, relation.spec);
    validateBatchSemanticRelationAuthority(sourceDecision, relation.targetDecision);
    const id = relationId();
    const relationChangeId = changeId();
    relationIds.push(id);

    statements.push(
      env.DB.prepare(`INSERT INTO semantic_relations(
        id,space_id,source_model_key,source_record_id,predicate,target_model_key,target_record_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?)`).bind(
        id,
        spaceId,
        sourceModel.key,
        sourceResource.id,
        relation.spec.predicate,
        relation.targetModel.key,
        relation.targetResource.id,
        timestamp,
      ),
      env.DB.prepare(`INSERT INTO semantic_relation_changes(
        id,relation_id,space_id,source_model_key,source_record_id,predicate,
        target_model_key,target_record_id,operation,principal_type,principal_id,
        actor_type,actor_id,application_id,delegation_id,source_resource_change_id,
        change_set_id,occurred_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        relationChangeId,
        id,
        spaceId,
        sourceModel.key,
        sourceResource.id,
        relation.spec.predicate,
        relation.targetModel.key,
        relation.targetResource.id,
        "create",
        principal.type,
        principal.id,
        executedBy.type,
        executedBy.id,
        principal.clientId,
        sourceDecision.authority.delegationId,
        sourceChangeId,
        changeSetId,
        timestamp,
      ),
    );
  }

  return { statements, relationIds };
}

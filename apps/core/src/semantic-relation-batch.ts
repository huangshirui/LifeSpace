import { ApiError } from "./http";
import type { ModelAccessDecision } from "./model-authorization";
import type { PublishedModel } from "./model-registry";
import {
  semanticRelationAllowsEndpoints,
  type SemanticRelationPredicate,
} from "./semantic-relation-definition";
import type { SemanticEntityRef } from "./semantic-relation";

export type BatchSemanticRelationSpec = {
  predicate: SemanticRelationPredicate;
  target: SemanticEntityRef;
};

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


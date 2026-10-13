export const SEMANTIC_RELATION_PREDICATES = {
  relates_to: {
    title: "Relates to",
    description: "A general business-semantic association when no more specific registered predicate applies.",
    pairs: [{ sourceModel: "*", targetModel: "*" }],
  },
  monitors: {
    title: "Monitors",
    description: "The source tracks or watches the target as an ongoing business concern.",
    pairs: [{ sourceModel: "health_concern", targetModel: "health_metric" }],
  },
  based_on: {
    title: "Based on",
    description: "The source assessment or conclusion is based on the target evidence or observation.",
    pairs: [
      { sourceModel: "health_assessment", targetModel: "health_observation" },
      { sourceModel: "health_assessment", targetModel: "health_document" },
    ],
  },
  generated_from: {
    title: "Generated from",
    description: "The source was generated from the target plan, regimen, or other governing business object.",
    pairs: [{ sourceModel: "task", targetModel: "*" }],
  },
  follows_up: {
    title: "Follows up",
    description: "The source is a follow-up action for the target business concern.",
    pairs: [{ sourceModel: "task", targetModel: "health_concern" }],
  },
  observed_during: {
    title: "Observed during",
    description: "The source observation occurred during the target session or activity.",
    pairs: [{ sourceModel: "health_observation", targetModel: "exercise_session" }],
  },
  addresses: {
    title: "Addresses",
    description: "The source goal or action addresses the target concern or objective.",
    pairs: [
      { sourceModel: "goal", targetModel: "health_concern" },
      { sourceModel: "goal", targetModel: "project" },
      { sourceModel: "goal", targetModel: "financial_target" },
    ],
  },
} as const;

export type SemanticRelationPredicate = keyof typeof SEMANTIC_RELATION_PREDICATES;
export type SemanticRelationDefinition = {
  outgoing?: SemanticRelationPredicate[];
};

export const SEMANTIC_RELATION_RUNTIME = {
  endpointOrigin: "native_or_bound_external",
  atomicBatch: true,
  crossStoreAtomic: false,
  externalEndpointResolution: true,
  batchPathTemplate: "/api/v1/spaces/{spaceId}/models/batch",
} as const;

export function isSemanticRelationPredicate(value: string): value is SemanticRelationPredicate {
  return Object.prototype.hasOwnProperty.call(SEMANTIC_RELATION_PREDICATES, value);
}

export function semanticRelationAllowsSource(
  predicate: SemanticRelationPredicate,
  sourceModel: string,
): boolean {
  return SEMANTIC_RELATION_PREDICATES[predicate].pairs.some((pair) =>
    pair.sourceModel === "*" || pair.sourceModel === sourceModel
  );
}

export function semanticRelationAllowsEndpoints(
  predicate: SemanticRelationPredicate,
  sourceModel: string,
  targetModel: string,
): boolean {
  return SEMANTIC_RELATION_PREDICATES[predicate].pairs.some((pair) =>
    (pair.sourceModel === "*" || pair.sourceModel === sourceModel)
    && (pair.targetModel === "*" || pair.targetModel === targetModel)
  );
}

export function semanticRelationDiscovery(
  sourceModel: string,
  declaration: SemanticRelationDefinition | undefined,
) {
  return (declaration?.outgoing ?? []).map((predicate) => {
    const definition = SEMANTIC_RELATION_PREDICATES[predicate];
    const targets = definition.pairs
      .filter((pair) => pair.sourceModel === "*" || pair.sourceModel === sourceModel)
      .map((pair) => pair.targetModel);
    return {
      predicate,
      direction: "outgoing" as const,
      title: definition.title,
      description: definition.description,
      targetModels: [...new Set(targets)],
    };
  });
}


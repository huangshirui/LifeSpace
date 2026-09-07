import type { FieldDefinition } from "./model-definition";

export const RELATION_TARGET_LOOKUP_PATH = "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}" as const;
export const REFERENCE_RESOLUTION_PATH = "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}" as const;
export const REFERENCE_RESOLUTION_MAX_IDS = 50 as const;

export type RelationLookupDescriptor =
  | {
    supported: true;
    method: "GET";
    pathTemplate: typeof RELATION_TARGET_LOOKUP_PATH;
    searchParameter: "q";
    cursorParameter: "cursor";
    limitParameter: "limit";
  }
  | {
    supported: false;
    reason: "reference-label-unavailable";
  };

export type RelationResolutionDescriptor =
  | {
    supported: true;
    method: "POST";
    pathTemplate: typeof REFERENCE_RESOLUTION_PATH;
    maxIds: typeof REFERENCE_RESOLUTION_MAX_IDS;
  }
  | {
    supported: false;
    reason: "reference-label-unavailable";
  };

export type RelationDiscoveryMetadata = {
  targetModel: string;
  cardinality: "one" | "many";
  lookup: RelationLookupDescriptor;
  resolution: RelationResolutionDescriptor;
};

const personLookup: RelationLookupDescriptor = {
  supported: true,
  method: "GET",
  pathTemplate: RELATION_TARGET_LOOKUP_PATH,
  searchParameter: "q",
  cursorParameter: "cursor",
  limitParameter: "limit",
};

const personResolution: RelationResolutionDescriptor = {
  supported: true,
  method: "POST",
  pathTemplate: REFERENCE_RESOLUTION_PATH,
  maxIds: REFERENCE_RESOLUTION_MAX_IDS,
};

const unavailable = (): { supported: false; reason: "reference-label-unavailable" } => ({
  supported: false,
  reason: "reference-label-unavailable",
});

export function relationDiscoveryMetadata(field: FieldDefinition): RelationDiscoveryMetadata | null {
  switch (field.type) {
    case "person":
      return {
        targetModel: "person",
        cardinality: "one",
        lookup: structuredClone(personLookup),
        resolution: structuredClone(personResolution),
      };
    case "person_list":
      return {
        targetModel: "person",
        cardinality: "many",
        lookup: structuredClone(personLookup),
        resolution: structuredClone(personResolution),
      };
    case "record":
      return {
        targetModel: field.targetModel!,
        cardinality: "one",
        lookup: unavailable(),
        resolution: unavailable(),
      };
    case "record_list":
      return {
        targetModel: field.targetModel!,
        cardinality: "many",
        lookup: unavailable(),
        resolution: unavailable(),
      };
    default:
      return null;
  }
}

export function relationSemanticMetadata(field: FieldDefinition): {
  targetModel: string;
  cardinality: "one" | "many";
  resolution: RelationResolutionDescriptor;
} | null {
  const relation = relationDiscoveryMetadata(field);
  if (!relation) return null;
  return {
    targetModel: relation.targetModel,
    cardinality: relation.cardinality,
    resolution: structuredClone(relation.resolution),
  };
}

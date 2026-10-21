import baselineModels from "../model-catalog/baseline-models.json";
import type { ModelDefinition } from "./model-definition";

// The checked-in JSON catalog is the single editable source for the shipped
// baseline Model Definitions. Historical SQL migrations remain immutable
// publication snapshots; integration tests prove their final published state
// converges back to this catalog.
const modelDefinition = (value: unknown): ModelDefinition => value as ModelDefinition;

export const TASK_MODEL_DEFINITION = modelDefinition(baselineModels.task);
export const WISH_MODEL_DEFINITION = modelDefinition(baselineModels.wish);
export const DAY_RECORD_MODEL_DEFINITION = modelDefinition(baselineModels.day_record);
export const EVENT_MODEL_DEFINITION = modelDefinition(baselineModels.event);
export const PERSON_GROUP_MODEL_DEFINITION = modelDefinition(baselineModels.person_group);
export const ANNIVERSARY_MODEL_DEFINITION = modelDefinition(baselineModels.anniversary);
export const ACTIVITY_MODEL_DEFINITION = modelDefinition(baselineModels.activity);
export const GOAL_MODEL_DEFINITION = modelDefinition(baselineModels.goal);
export const PERSON_PROFILE_MODEL_DEFINITION = modelDefinition(baselineModels.person_profile);
export const HABIT_MODEL_DEFINITION = modelDefinition(baselineModels.habit);

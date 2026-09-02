import { readFileSync } from "node:fs";

const catalogUrl = new URL("../../apps/core/model-catalog/baseline-models.json", import.meta.url);
const baselineCatalog = JSON.parse(readFileSync(catalogUrl, "utf8"));

function semanticProjection(definition) {
  return Object.freeze({
    route: definition.route,
    description: definition.description,
    fields: Object.freeze(Object.fromEntries(
      Object.entries(definition.fields)
        .filter(([, field]) => typeof field.description === "string")
        .map(([fieldKey, field]) => [fieldKey, field.description]),
    )),
  });
}

// Compatibility export for existing deployment/verifier scripts. The values are
// projections from the canonical shipped Model Catalog rather than an editable
// second copy of model/field semantics.
export const BASELINE_MODEL_SEMANTICS = Object.freeze(Object.fromEntries(
  Object.entries(baselineCatalog).map(([modelKey, definition]) => [
    modelKey,
    semanticProjection(definition),
  ]),
));

export function applyBaselineModelSemantics(definition, expected) {
  const next = structuredClone(definition);
  next.description = expected.description;
  for (const [fieldKey, description] of Object.entries(expected.fields)) {
    if (!next.fields?.[fieldKey]) {
      throw new Error(`Published model ${definition.key} is missing expected field ${fieldKey}`);
    }
    next.fields[fieldKey].description = description;
  }
  return next;
}

export function baselineModelSemanticsMatch(definition, expected) {
  if (definition.description !== expected.description) return false;
  return Object.entries(expected.fields).every(
    ([fieldKey, description]) => definition.fields?.[fieldKey]?.description === description,
  );
}

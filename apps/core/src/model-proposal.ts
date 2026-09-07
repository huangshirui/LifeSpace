import type { ModelDefinition } from "./model-definition";
import type { ModelCompatibility, PublishedModel } from "./model-registry";

export type ModelDefinitionChange = {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};

export type ModelDefinitionDiff = {
  baseModelVersion: number | null;
  changes: ModelDefinitionChange[];
  breakingReasons: string[];
  recommendedCompatibility: ModelCompatibility;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function collectChanges(
  before: unknown,
  after: unknown,
  path = "$",
  changes: ModelDefinitionChange[] = [],
): ModelDefinitionChange[] {
  if (equal(before, after)) return changes;
  if (before === undefined) {
    changes.push({ path, kind: "added", after: structuredClone(after) });
    return changes;
  }
  if (after === undefined) {
    changes.push({ path, kind: "removed", before: structuredClone(before) });
    return changes;
  }
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      collectChanges(before[key], after[key], path === "$" ? key : `${path}.${key}`, changes);
    }
    return changes;
  }
  changes.push({
    path,
    kind: "changed",
    before: structuredClone(before),
    after: structuredClone(after),
  });
  return changes;
}

function setContainsAll(next: string[] | undefined, previous: string[] | undefined): boolean {
  const nextSet = new Set(next ?? []);
  return (previous ?? []).every((item) => nextSet.has(item));
}

function fieldBehavior(field: ModelDefinition["fields"][string] | undefined): unknown {
  if (!field) return undefined;
  const { description: _description, ...behavior } = field;
  return behavior;
}

function defaultPresent(definition: ModelDefinition, fieldKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(definition.defaults ?? {}, fieldKey);
}

function obviousCompatibilityReasons(base: ModelDefinition, next: ModelDefinition): string[] {
  const reasons: string[] = [];
  if (base.definitionVersion !== next.definitionVersion) reasons.push("definitionVersion changed");
  if (base.key !== next.key) reasons.push("model key changed");
  if (base.route !== next.route) reasons.push("model route changed");
  if (!equal(base.referenceLabel, next.referenceLabel)) reasons.push("record reference-label semantics changed");

  for (const [fieldKey, oldField] of Object.entries(base.fields)) {
    const newField = next.fields[fieldKey];
    if (!newField) {
      reasons.push(`field ${fieldKey} was removed`);
      continue;
    }
    if (!equal(fieldBehavior(oldField), fieldBehavior(newField))) {
      reasons.push(`field ${fieldKey} constraints/type/behavior changed`);
    }
    const oldDefault = defaultPresent(base, fieldKey) ? base.defaults![fieldKey] : undefined;
    const newDefault = defaultPresent(next, fieldKey) ? next.defaults![fieldKey] : undefined;
    if (!equal(oldDefault, newDefault)) {
      reasons.push(`default for existing field ${fieldKey} changed`);
    }
  }

  for (const [fieldKey, field] of Object.entries(next.fields)) {
    if (base.fields[fieldKey]) continue;
    if (field.required && !defaultPresent(next, fieldKey)) {
      reasons.push(`new required field ${fieldKey} has no server default`);
    }
  }

  for (const queryKind of ["searchable", "filterable", "sortable"] as const) {
    if (!setContainsAll(next.query?.[queryKind], base.query?.[queryKind])) {
      reasons.push(`query.${queryKind} removed an existing capability`);
    }
  }

  if (!setContainsAll(next.access, base.access)) {
    reasons.push("model access removed an existing access capability");
  }

  if (!equal(base.capabilities, next.capabilities)) reasons.push("Capability configuration changed");
  if (!equal(base.policies, next.policies)) reasons.push("Policy semantics changed");

  const oldActions = base.actions ?? {};
  const newActions = next.actions ?? {};
  for (const [actionKey, action] of Object.entries(oldActions)) {
    if (!newActions[actionKey]) {
      reasons.push(`action ${actionKey} was removed`);
    } else if (!equal(action, newActions[actionKey])) {
      reasons.push(`action ${actionKey} semantics changed`);
    }
  }

  return [...new Set(reasons)];
}

export function diffModelDefinition(
  base: PublishedModel | null,
  next: ModelDefinition,
): ModelDefinitionDiff {
  if (!base) {
    return {
      baseModelVersion: null,
      changes: [{ path: "$", kind: "added", after: structuredClone(next) }],
      breakingReasons: [],
      recommendedCompatibility: "initial",
    };
  }

  const breakingReasons = obviousCompatibilityReasons(base.definition, next);
  return {
    baseModelVersion: base.version,
    changes: collectChanges(base.definition, next),
    breakingReasons,
    recommendedCompatibility: breakingReasons.length ? "breaking" : "compatible",
  };
}

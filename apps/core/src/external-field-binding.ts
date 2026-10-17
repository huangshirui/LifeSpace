import type { Bindings } from "./env";
import type { ExternalSnapshot } from "./external-model";

const FIELD_KEY = /^[a-z][A-Za-z0-9]{0,62}$/u;
const RESERVED_FIELDS = new Set([
  "id",
  "spaceId",
  "modelKey",
  "modelVersion",
  "version",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "createdBy",
  "updatedBy",
]);

export type ExternalFieldBinding = {
  model_key: string;
  source_field_id: string;
  field_key: string;
  created_at: string;
  updated_at: string;
};

export type PendingExternalFieldBinding = {
  sourceFieldId: string;
  key: string;
};

function simpleFieldKey(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed || /[^\x00-\x7F]/u.test(trimmed)) return null;

  if (/^[A-Za-z][A-Za-z0-9]*$/u.test(trimmed)) {
    if (/^[A-Z0-9]+$/u.test(trimmed)) return trimmed.toLowerCase();
    return trimmed[0]!.toLowerCase() + trimmed.slice(1);
  }

  const tokens = trimmed.match(/[A-Za-z0-9]+/gu);
  if (!tokens?.length || !/^[A-Za-z]/u.test(tokens[0]!)) return null;
  const first = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1).map((token) => {
    const lower = token.toLowerCase();
    return lower[0]!.toUpperCase() + lower.slice(1);
  });
  const candidate = first + rest.join("");
  return FIELD_KEY.test(candidate) ? candidate : null;
}

async function shortHash(value: string, length = 8): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

async function baseCandidate(title: string, sourceFieldId: string): Promise<string> {
  const simple = simpleFieldKey(title);
  if (simple && !RESERVED_FIELDS.has(simple)) return simple;
  return `field${await shortHash(sourceFieldId)}`;
}

async function suffixedCandidate(base: string, sourceFieldId: string): Promise<string> {
  const suffix = await shortHash(sourceFieldId, 6);
  const head = base.slice(0, Math.max(1, 63 - suffix.length));
  const candidate = `${head}${suffix}`;
  if (FIELD_KEY.test(candidate) && !RESERVED_FIELDS.has(candidate)) return candidate;
  return `field${await shortHash(sourceFieldId, 12)}`;
}

export async function stabilizeExternalFieldKeys(
  env: Bindings,
  modelKey: string,
  snapshot: ExternalSnapshot,
): Promise<{ snapshot: ExternalSnapshot; newBindings: PendingExternalFieldBinding[] }> {
  const rows = await env.DB.prepare(
    "SELECT model_key,source_field_id,field_key,created_at,updated_at FROM external_field_bindings WHERE model_key=? ORDER BY source_field_id",
  ).bind(modelKey).all<ExternalFieldBinding>();

  const existingBySource = new Map(rows.results.map((row) => [row.source_field_id, row.field_key]));
  const historicalKeys = new Set(rows.results.map((row) => row.field_key));
  const incomingIds = new Set<string>();
  for (const field of snapshot.fields) {
    if (incomingIds.has(field.sourceFieldId)) throw new Error("Duplicate external source field identity");
    incomingIds.add(field.sourceFieldId);
  }

  const provisional = new Map<string, string>();
  for (const field of snapshot.fields) {
    if (existingBySource.has(field.sourceFieldId)) continue;
    provisional.set(field.sourceFieldId, await baseCandidate(field.title, field.sourceFieldId));
  }

  const candidateCounts = new Map<string, number>();
  for (const candidate of provisional.values()) {
    candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1);
  }

  const newBindings: PendingExternalFieldBinding[] = [];
  const assigned = new Set(historicalKeys);
  const resolvedBySource = new Map(existingBySource);
  for (const field of [...snapshot.fields].sort((a, b) => a.sourceFieldId.localeCompare(b.sourceFieldId))) {
    if (resolvedBySource.has(field.sourceFieldId)) continue;
    const base = provisional.get(field.sourceFieldId)!;
    const collision = historicalKeys.has(base)
      || RESERVED_FIELDS.has(base)
      || !FIELD_KEY.test(base)
      || (candidateCounts.get(base) ?? 0) > 1;
    let key = collision ? await suffixedCandidate(base, field.sourceFieldId) : base;
    while (assigned.has(key) || RESERVED_FIELDS.has(key) || !FIELD_KEY.test(key)) {
      key = await suffixedCandidate(`field${await shortHash(field.sourceFieldId, 10)}`, field.sourceFieldId + key);
    }
    assigned.add(key);
    resolvedBySource.set(field.sourceFieldId, key);
    newBindings.push({ sourceFieldId: field.sourceFieldId, key });
  }

  const fields = snapshot.fields
    .map((field) => ({ ...field, key: resolvedBySource.get(field.sourceFieldId)! }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    snapshot: { ...snapshot, fields },
    newBindings,
  };
}

export function externalFieldBindingStatements(
  env: Bindings,
  modelKey: string,
  bindings: readonly PendingExternalFieldBinding[],
  timestamp: string,
): D1PreparedStatement[] {
  return bindings.map((binding) => env.DB.prepare(
    "INSERT INTO external_field_bindings(model_key,source_field_id,field_key,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(model_key,source_field_id) DO NOTHING",
  ).bind(modelKey, binding.sourceFieldId, binding.key, timestamp, timestamp));
}

export const externalFieldKeyRules = {
  pattern: FIELD_KEY,
  reserved: RESERVED_FIELDS,
  normalize: simpleFieldKey,
};

import type { Bindings } from "./env";
import type { ExternalSnapshot } from "./external-model";
import { allD1Batched, chunkD1Values } from "./d1-batch";
import { FIELD_KEY, RESERVED_FIELDS } from "./model-definition";

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

type ExternalFieldCandidate = {
  sourceFieldId: string;
  base: string;
  suffixed: string;
  fallback: string;
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
  return simpleFieldKey(title) ?? `field${await shortHash(sourceFieldId)}`;
}

async function suffixedCandidate(base: string, sourceFieldId: string): Promise<string> {
  const suffix = await shortHash(sourceFieldId, 6);
  const head = base.slice(0, Math.max(1, 63 - suffix.length));
  const candidate = `${head}${suffix}`;
  if (FIELD_KEY.test(candidate) && !RESERVED_FIELDS.has(candidate)) return candidate;
  return `field${await shortHash(sourceFieldId, 48)}`;
}

async function fieldCandidates(snapshot: ExternalSnapshot): Promise<ExternalFieldCandidate[]> {
  return Promise.all(snapshot.fields.map(async (field) => {
    const base = await baseCandidate(field.title, field.sourceFieldId);
    return {
      sourceFieldId: field.sourceFieldId,
      base,
      suffixed: await suffixedCandidate(base, field.sourceFieldId),
      fallback: `field${await shortHash(field.sourceFieldId, 48)}`,
    };
  }));
}

async function relevantBindings(
  env: Bindings,
  modelKey: string,
  candidates: readonly ExternalFieldCandidate[],
): Promise<ExternalFieldBinding[]> {
  if (!candidates.length) return [];
  const sourceIds = [...new Set(candidates.map((candidate) => candidate.sourceFieldId))];
  const candidateKeys = [...new Set(candidates.flatMap((candidate) => [
    candidate.base,
    candidate.suffixed,
    candidate.fallback,
  ]))];
  const columns = "model_key,source_field_id,field_key,created_at,updated_at";
  const statements: D1PreparedStatement[] = [];
  for (const chunk of chunkD1Values(sourceIds, 1)) {
    statements.push(env.DB.prepare(
      `SELECT ${columns} FROM external_field_bindings WHERE model_key=? AND source_field_id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(modelKey, ...chunk));
  }
  for (const chunk of chunkD1Values(candidateKeys, 1)) {
    statements.push(env.DB.prepare(
      `SELECT ${columns} FROM external_field_bindings WHERE model_key=? AND field_key IN (${chunk.map(() => "?").join(",")})`,
    ).bind(modelKey, ...chunk));
  }
  const rows = await allD1Batched<ExternalFieldBinding>(env.DB, statements);
  return [...new Map(rows.map((row) => [row.source_field_id, row])).values()];
}

export async function resolveExternalFieldKeys(
  snapshot: ExternalSnapshot,
  rows: readonly ExternalFieldBinding[],
): Promise<{ snapshot: ExternalSnapshot; newBindings: PendingExternalFieldBinding[] }> {
  const candidates = await fieldCandidates(snapshot);
  const candidateBySource = new Map(candidates.map((candidate) => [candidate.sourceFieldId, candidate]));
  const existingBySource = new Map(rows.map((row) => [row.source_field_id, row.field_key]));
  const historicalKeys = new Set(rows.map((row) => row.field_key));
  const incomingIds = new Set<string>();
  for (const field of snapshot.fields) {
    if (incomingIds.has(field.sourceFieldId)) throw new Error("Duplicate external source field identity");
    incomingIds.add(field.sourceFieldId);
  }

  const candidateCounts = new Map<string, number>();
  for (const field of snapshot.fields) {
    if (existingBySource.has(field.sourceFieldId)) continue;
    const base = candidateBySource.get(field.sourceFieldId)!.base;
    candidateCounts.set(base, (candidateCounts.get(base) ?? 0) + 1);
  }

  const newBindings: PendingExternalFieldBinding[] = [];
  const assigned = new Set(historicalKeys);
  const resolvedBySource = new Map(existingBySource);
  for (const field of [...snapshot.fields].sort((a, b) => a.sourceFieldId.localeCompare(b.sourceFieldId))) {
    if (resolvedBySource.has(field.sourceFieldId)) continue;
    const candidate = candidateBySource.get(field.sourceFieldId)!;
    const collision = historicalKeys.has(candidate.base)
      || RESERVED_FIELDS.has(candidate.base)
      || !FIELD_KEY.test(candidate.base)
      || (candidateCounts.get(candidate.base) ?? 0) > 1;
    let key = collision ? candidate.suffixed : candidate.base;
    if (assigned.has(key) || RESERVED_FIELDS.has(key) || !FIELD_KEY.test(key)) {
      key = candidate.fallback;
    }
    if (assigned.has(key) || RESERVED_FIELDS.has(key) || !FIELD_KEY.test(key)) {
      throw new Error("Unable to assign a stable external field key");
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

async function resolveFromDatabase(
  env: Bindings,
  modelKey: string,
  snapshot: ExternalSnapshot,
): Promise<{ snapshot: ExternalSnapshot; newBindings: PendingExternalFieldBinding[] }> {
  const candidates = await fieldCandidates(snapshot);
  return resolveExternalFieldKeys(snapshot, await relevantBindings(env, modelKey, candidates));
}

export async function stabilizeExternalFieldKeys(
  env: Bindings,
  modelKey: string,
  snapshot: ExternalSnapshot,
): Promise<{ snapshot: ExternalSnapshot; newBindings: PendingExternalFieldBinding[] }> {
  const modelExists = Boolean(await env.DB.prepare(
    "SELECT 1 AS present FROM external_models WHERE model_key=?",
  ).bind(modelKey).first<{ present: number }>());

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resolved = await resolveFromDatabase(env, modelKey, snapshot);
    if (!modelExists || !resolved.newBindings.length) return resolved;

    await env.DB.batch(resolved.newBindings.map((binding) => env.DB.prepare(
      "INSERT OR IGNORE INTO external_field_bindings(model_key,source_field_id,field_key,created_at,updated_at) VALUES(?,?,?,?,?)",
    ).bind(modelKey, binding.sourceFieldId, binding.key, new Date().toISOString(), new Date().toISOString())));
  }

  const resolved = await resolveFromDatabase(env, modelKey, snapshot);
  if (!resolved.newBindings.length) return resolved;
  throw new Error("Unable to persist stable external field bindings");
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

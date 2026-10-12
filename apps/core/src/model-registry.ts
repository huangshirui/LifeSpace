import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import { generateModelContract } from "./model-contract";
import { modelContractMutationStatements } from "./model-contract-store";
import {
  canonicalModelDefinition,
  type FieldDefinition,
  type ModelDefinition,
  type ModelValidationIssue,
  validateModelDefinition,
} from "./model-definition";
import { physicalPublicationStatements, registryMutationGuardStatement } from "./model-physical-publication";
import { diffModelDefinition } from "./model-proposal";

export type ModelCompatibility = "initial" | "compatible" | "breaking";

export type PublishedModel = {
  id: string;
  key: string;
  version: number;
  state: "published" | "superseded" | "retired";
  schemaHash: string;
  compatibility: ModelCompatibility;
  definition: ModelDefinition;
  publishedAt: string;
};

export type RuntimeModelDescriptor = PublishedModel & {
  runtime: {
    fields: ReadonlyMap<string, FieldDefinition>;
    allowedQueryKeys: ReadonlySet<string>;
    searchable: readonly string[];
    filterable: readonly string[];
    sortable: readonly string[];
    relationFields: readonly string[];
  };
};

type ModelRow = {
  id: string;
  model_key: string;
  version: number;
  state: PublishedModel["state"];
  definition_json: string;
  schema_hash: string;
  compatibility: ModelCompatibility;
  published_at: string;
};

type RegistryStateRow = {
  revision: number;
  mutation_token: string | null;
};

type RuntimeRegistrySnapshot = {
  expiresAt: number;
  byKey: Map<string, RuntimeModelDescriptor>;
};

const RUNTIME_REGISTRY_TTL_MS = 60_000;
const runtimeRegistrySnapshots = new WeakMap<object, RuntimeRegistrySnapshot>();
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function actorName(principal: Principal): string {
  return principal.displayName?.trim() || principal.id;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowToPublished(row: ModelRow): PublishedModel {
  let definition: ModelDefinition;
  try {
    const stored = JSON.parse(row.definition_json) as ModelDefinition & { route?: unknown };
    // Schema 37 removes route from current definitions. Stripping it here also
    // keeps historical immutable rows readable during rolling deployment.
    const { route: _legacyRoute, ...current } = stored;
    definition = current as ModelDefinition;
  } catch {
    throw new ApiError("MODEL_REGISTRY_CORRUPT", `Stored definition for ${row.model_key} is invalid JSON`, 500);
  }
  const validation = validateModelDefinition(definition);
  if (!validation.valid) {
    throw new ApiError("MODEL_REGISTRY_CORRUPT", `Stored definition for ${row.model_key} no longer validates`, 500);
  }
  return {
    id: row.id,
    key: row.model_key,
    version: row.version,
    state: row.state,
    schemaHash: row.schema_hash,
    compatibility: row.compatibility,
    definition: validation.definition,
    publishedAt: row.published_at,
  };
}

function compileRuntimeModel(model: PublishedModel): RuntimeModelDescriptor {
  const searchable = Object.freeze([...(model.definition.query?.searchable ?? [])]);
  const filterable = Object.freeze([...(model.definition.query?.filterable ?? [])]);
  const sortable = Object.freeze([...(model.definition.query?.sortable ?? [])]);
  const allowedQueryKeys = new Set<string>(["q", "sort", "cursor", "limit"]);
  for (const fieldKey of filterable) {
    allowedQueryKeys.add(fieldKey);
    const field = model.definition.fields[fieldKey];
    if (field && ["date", "instant", "datetime", "integer", "number"].includes(field.type)) {
      allowedQueryKeys.add(`${fieldKey}From`);
      allowedQueryKeys.add(`${fieldKey}To`);
    }
  }
  const relationFields = Object.entries(model.definition.fields)
    .filter(([, field]) => ["person", "person_list", "record", "record_list"].includes(field.type))
    .map(([fieldKey]) => fieldKey);
  return {
    ...model,
    runtime: {
      fields: new Map(Object.entries(model.definition.fields)),
      allowedQueryKeys,
      searchable,
      filterable,
      sortable,
      relationFields: Object.freeze(relationFields),
    },
  };
}

async function loadRuntimeRegistrySnapshot(env: Bindings): Promise<RuntimeRegistrySnapshot> {
  const models = await listPublishedModels(env);
  const descriptors = models.map(compileRuntimeModel);
  const snapshot: RuntimeRegistrySnapshot = {
    expiresAt: Date.now() + RUNTIME_REGISTRY_TTL_MS,
    byKey: new Map(descriptors.map((model) => [model.key, model])),
  };
  runtimeRegistrySnapshots.set(env.DB as unknown as object, snapshot);
  return snapshot;
}

async function runtimeRegistrySnapshot(env: Bindings): Promise<RuntimeRegistrySnapshot> {
  const key = env.DB as unknown as object;
  const cached = runtimeRegistrySnapshots.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  return loadRuntimeRegistrySnapshot(env);
}

export function invalidateRuntimeModelRegistry(env: Bindings): void {
  runtimeRegistrySnapshots.delete(env.DB as unknown as object);
}

export async function getRuntimeModel(env: Bindings, key: string): Promise<RuntimeModelDescriptor | null> {
  return (await runtimeRegistrySnapshot(env)).byKey.get(key) ?? null;
}

/** Stable metadata only; querying this catalog never caches mutable Authority. */
export async function listRuntimeModels(env: Bindings): Promise<RuntimeModelDescriptor[]> {
  return [...(await runtimeRegistrySnapshot(env)).byKey.values()];
}

export async function validateDefinition(input: unknown): Promise<
  | { valid: true; definition: ModelDefinition; schemaHash: string }
  | { valid: false; issues: ModelValidationIssue[] }
> {
  const validation = validateModelDefinition(input);
  if (!validation.valid) return validation;
  if (validation.definition.key.startsWith("ext_")) return { valid: false, issues: [{ path: "key", code: "RESERVED_MODEL_KEY", message: "ext_ is reserved for Space-local External Models" }] };
  return {
    valid: true,
    definition: validation.definition,
    schemaHash: await sha256Hex(validation.hashInput),
  };
}

export function validateCanonicalTemporalDslTransition(
  current: ModelDefinition | null,
  next: ModelDefinition,
): ModelValidationIssue[] {
  const issues: ModelValidationIssue[] = [];

  for (const [fieldKey, field] of Object.entries(next.fields)) {
    if (field.type !== "datetime") continue;
    if (current?.fields[fieldKey]?.type === "datetime") continue;
    issues.push({
      path: `fields.${fieldKey}.type`,
      code: "LEGACY_DATETIME_NOT_PUBLISHABLE",
      message: "datetime is a legacy published spelling; new Instant fields must use type instant",
    });
  }

  for (const [rangeKey, range] of Object.entries(next.timeRanges ?? {})) {
    const previous = current?.timeRanges?.[rangeKey];
    if (previous && JSON.stringify(previous) === JSON.stringify(range)) continue;
    issues.push({
      path: `timeRanges.${rangeKey}`,
      code: "LEGACY_TIME_RANGE_BINDING_NOT_PUBLISHABLE",
      message: "timeRanges is a legacy structural projection; new range values must use range<date> or range<instant> fields",
    });
  }

  return issues;
}

export async function validateDefinitionForPublication(
  env: Bindings,
  input: unknown,
): Promise<
  | { valid: true; definition: ModelDefinition; schemaHash: string }
  | { valid: false; issues: ModelValidationIssue[] }
> {
  const validation = await validateDefinition(input);
  if (!validation.valid) return validation;
  const current = await getPublishedModel(env, validation.definition.key);
  const issues = validateCanonicalTemporalDslTransition(current?.definition ?? null, validation.definition);
  if (issues.length) return { valid: false, issues };
  return validation;
}

export async function getPublishedModel(env: Bindings, key: string): Promise<PublishedModel | null> {
  const row = await env.DB.prepare(`SELECT id,model_key,version,state,definition_json,schema_hash,compatibility,published_at
    FROM model_definitions WHERE model_key=? AND state='published' LIMIT 1`)
    .bind(key).first<ModelRow>();
  return row ? rowToPublished(row) : null;
}

export async function listPublishedModels(env: Bindings): Promise<PublishedModel[]> {
  const rows = await env.DB.prepare(`SELECT id,model_key,version,state,definition_json,schema_hash,compatibility,published_at
    FROM model_definitions WHERE state='published' ORDER BY model_key ASC`).all<ModelRow>();
  return rows.results.map(rowToPublished);
}

export async function getModelRegistryRevision(env: Bindings): Promise<number> {
  const row = await env.DB.prepare("SELECT revision,mutation_token FROM model_registry_state WHERE singleton=1")
    .first<RegistryStateRow>();
  if (!row) throw new ApiError("MODEL_REGISTRY_INCONSISTENT", "Model registry state is missing", 500);
  if (row.mutation_token !== null) throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Model registry is currently mutating", 409);
  return row.revision;
}

function registryGuardSql(): string {
  return "EXISTS(SELECT 1 FROM model_registry_state WHERE singleton=1 AND revision=? AND mutation_token=?)";
}

export async function publishModelDefinition(
  env: Bindings,
  principal: Principal,
  input: unknown,
  compatibility: ModelCompatibility,
): Promise<PublishedModel> {
  const validation = await validateDefinition(input);
  if (!validation.valid) {
    throw new ApiError("INVALID_MODEL_DEFINITION", JSON.stringify(validation.issues), 422);
  }

  const expectedRevision = await getModelRegistryRevision(env);
  const currentModels = await listPublishedModels(env);
  const current = currentModels.find((model) => model.key === validation.definition.key) ?? null;
  const temporalDslIssues = validateCanonicalTemporalDslTransition(current?.definition ?? null, validation.definition);
  if (temporalDslIssues.length) {
    throw new ApiError("INVALID_MODEL_DEFINITION", JSON.stringify(temporalDslIssues), 422);
  }
  if (!current && compatibility !== "initial") {
    throw new ApiError("INVALID_MODEL_COMPATIBILITY", "The first published version must use compatibility=initial", 400);
  }
  if (current && compatibility === "initial") {
    throw new ApiError("INVALID_MODEL_COMPATIBILITY", "A subsequent model version cannot use compatibility=initial", 400);
  }
  if (current?.schemaHash === validation.schemaHash) {
    throw new ApiError("MODEL_DEFINITION_UNCHANGED", "The published model definition is unchanged", 409);
  }
  const compatibilityDiff = diffModelDefinition(current, validation.definition);
  if (compatibilityDiff.recommendedCompatibility === "breaking" && compatibility !== "breaking") {
    throw new ApiError(
      "MODEL_COMPATIBILITY_UNDERSTATED",
      "The Model Definition change requires compatibility=breaking",
      409,
    );
  }

  const physicalStatements = physicalPublicationStatements(env, current?.definition ?? null, validation.definition);
  const nextVersion = (current?.version ?? 0) + 1;
  const id = createId("mdl");
  const definitionJson = canonicalModelDefinition(validation.definition);
  const publishedAt = new Date().toISOString();
  const targetRevision = expectedRevision + 1;
  const mutationToken = crypto.randomUUID();
  const candidate: PublishedModel = {
    id,
    key: validation.definition.key,
    version: nextVersion,
    state: "published",
    schemaHash: validation.schemaHash,
    compatibility,
    definition: validation.definition,
    publishedAt,
  };
  const nextModels = [...currentModels.filter((model) => model.key !== candidate.key), candidate];
  const contract = await generateModelContract(nextModels);

  const lock = env.DB.prepare(`UPDATE model_registry_state
    SET revision=revision+1,mutation_token=?,updated_at=?
    WHERE singleton=1 AND revision=? AND mutation_token IS NULL`)
    .bind(mutationToken, publishedAt, expectedRevision);
  const statements: D1PreparedStatement[] = [
    lock,
    registryMutationGuardStatement(env, targetRevision, mutationToken),
    ...physicalStatements,
  ];
  if (current) {
    statements.push(env.DB.prepare(`UPDATE model_definitions SET state='superseded',superseded_at=?
      WHERE id=? AND state='published' AND ${registryGuardSql()}`)
      .bind(publishedAt, current.id, targetRevision, mutationToken));
  }
  statements.push(env.DB.prepare(`INSERT INTO model_definitions(
      id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
      published_by_type,published_by_id,published_by_name_snapshot,published_at
    ) SELECT ?,?,?,?,'published',1,?,?,?,?,?,?,? WHERE ${registryGuardSql()}`)
    .bind(
      id,
      validation.definition.key,
      // Deprecated physical compatibility column retained by the D1-safe 0037
      // migration. Runtime addressing and collision rules use model_key only.
      validation.definition.key,
      nextVersion,
      definitionJson,
      validation.schemaHash,
      compatibility,
      principal.type,
      principal.id,
      actorName(principal),
      publishedAt,
      targetRevision,
      mutationToken,
    ));
  statements.push(...modelContractMutationStatements(env, contract, principal, publishedAt, targetRevision, mutationToken));
  statements.push(env.DB.prepare("UPDATE model_registry_state SET mutation_token=NULL WHERE singleton=1 AND revision=? AND mutation_token=?")
    .bind(targetRevision, mutationToken));

  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ message: "Model publication failed", modelKey: validation.definition.key, error: error instanceof Error ? error.message : String(error) }));
    throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Model publication conflicted with current registry or physical schema state", 409);
  }
  if (!results[0].meta.changes) throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Model registry changed concurrently", 409);

  invalidateRuntimeModelRegistry(env);
  const published = await getPublishedModel(env, validation.definition.key);
  if (!published || published.version !== nextVersion || published.schemaHash !== validation.schemaHash) {
    throw new ApiError("MODEL_REGISTRY_INCONSISTENT", "Published model could not be read back consistently", 500);
  }
  return published;
}

export async function retireModel(env: Bindings, principal: Principal, key: string): Promise<void> {
  const expectedRevision = await getModelRegistryRevision(env);
  const currentModels = await listPublishedModels(env);
  const current = currentModels.find((model) => model.key === key) ?? null;
  if (!current) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);

  const retiredAt = new Date().toISOString();
  const targetRevision = expectedRevision + 1;
  const mutationToken = crypto.randomUUID();
  const contract = await generateModelContract(currentModels.filter((model) => model.key !== key));
  const lock = env.DB.prepare(`UPDATE model_registry_state
    SET revision=revision+1,mutation_token=?,updated_at=?
    WHERE singleton=1 AND revision=? AND mutation_token IS NULL`)
    .bind(mutationToken, retiredAt, expectedRevision);
  const retire = env.DB.prepare(`UPDATE model_definitions SET state='retired',retired_at=?
    WHERE id=? AND state='published' AND ${registryGuardSql()}`)
    .bind(retiredAt, current.id, targetRevision, mutationToken);
  const statements = [
    lock,
    retire,
    ...modelContractMutationStatements(env, contract, principal, retiredAt, targetRevision, mutationToken),
    env.DB.prepare("UPDATE model_registry_state SET mutation_token=NULL WHERE singleton=1 AND revision=? AND mutation_token=?")
      .bind(targetRevision, mutationToken),
  ];

  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ message: "Model retirement failed", modelKey: key, error: error instanceof Error ? error.message : String(error) }));
    throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Model retirement conflicted with current registry state", 409);
  }
  if (!results[0].meta.changes || !results[1].meta.changes) {
    throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Published model changed concurrently", 409);
  }
  invalidateRuntimeModelRegistry(env);
}


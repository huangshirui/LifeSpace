import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import {
  canonicalModelDefinition,
  type ModelDefinition,
  type ModelValidationIssue,
  validateModelDefinition,
} from "./model-definition";

export type ModelCompatibility = "initial" | "compatible" | "breaking";

export type PublishedModel = {
  id: string;
  key: string;
  route: string;
  version: number;
  state: "published" | "superseded" | "retired";
  schemaHash: string;
  compatibility: ModelCompatibility;
  definition: ModelDefinition;
  publishedAt: string;
};

type ModelRow = {
  id: string;
  model_key: string;
  route_segment: string;
  version: number;
  state: PublishedModel["state"];
  definition_json: string;
  schema_hash: string;
  compatibility: ModelCompatibility;
  published_at: string;
};

const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function actorName(principal: Principal): string {
  return principal.id;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowToPublished(row: ModelRow): PublishedModel {
  let definition: ModelDefinition;
  try {
    definition = JSON.parse(row.definition_json) as ModelDefinition;
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
    route: row.route_segment,
    version: row.version,
    state: row.state,
    schemaHash: row.schema_hash,
    compatibility: row.compatibility,
    definition: validation.definition,
    publishedAt: row.published_at,
  };
}

export async function validateDefinition(input: unknown): Promise<
  | { valid: true; definition: ModelDefinition; schemaHash: string }
  | { valid: false; issues: ModelValidationIssue[] }
> {
  const validation = validateModelDefinition(input);
  if (!validation.valid) return validation;
  return {
    valid: true,
    definition: validation.definition,
    schemaHash: await sha256Hex(validation.hashInput),
  };
}

export async function getPublishedModel(env: Bindings, key: string): Promise<PublishedModel | null> {
  const row = await env.DB.prepare(`SELECT id,model_key,route_segment,version,state,definition_json,schema_hash,compatibility,published_at
    FROM model_definitions WHERE model_key=? AND state='published' LIMIT 1`)
    .bind(key).first<ModelRow>();
  return row ? rowToPublished(row) : null;
}

export async function getPublishedModelByRoute(env: Bindings, route: string): Promise<PublishedModel | null> {
  const row = await env.DB.prepare(`SELECT id,model_key,route_segment,version,state,definition_json,schema_hash,compatibility,published_at
    FROM model_definitions WHERE route_segment=? AND state='published' LIMIT 1`)
    .bind(route).first<ModelRow>();
  return row ? rowToPublished(row) : null;
}

export async function listPublishedModels(env: Bindings): Promise<PublishedModel[]> {
  const rows = await env.DB.prepare(`SELECT id,model_key,route_segment,version,state,definition_json,schema_hash,compatibility,published_at
    FROM model_definitions WHERE state='published' ORDER BY model_key ASC`).all<ModelRow>();
  return rows.results.map(rowToPublished);
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

  const current = await getPublishedModel(env, validation.definition.key);
  if (!current && compatibility !== "initial") {
    throw new ApiError("INVALID_MODEL_COMPATIBILITY", "The first published version must use compatibility=initial", 400);
  }
  if (current && compatibility === "initial") {
    throw new ApiError("INVALID_MODEL_COMPATIBILITY", "A subsequent model version cannot use compatibility=initial", 400);
  }
  if (current?.schemaHash === validation.schemaHash) {
    throw new ApiError("MODEL_DEFINITION_UNCHANGED", "The published model definition is unchanged", 409);
  }

  const routeOwner = await getPublishedModelByRoute(env, validation.definition.route);
  if (routeOwner && routeOwner.key !== validation.definition.key) {
    throw new ApiError("MODEL_ROUTE_CONFLICT", `Route ${validation.definition.route} is already owned by model ${routeOwner.key}`, 409);
  }

  const nextVersion = (current?.version ?? 0) + 1;
  const id = createId("mdl");
  const definitionJson = canonicalModelDefinition(validation.definition);
  const publishedAt = new Date().toISOString();

  const statements: D1PreparedStatement[] = [];
  if (current) {
    statements.push(env.DB.prepare(`UPDATE model_definitions SET state='superseded',superseded_at=?
      WHERE id=? AND state='published'`).bind(publishedAt, current.id));
  }
  statements.push(env.DB.prepare(`INSERT INTO model_definitions(
      id,model_key,route_segment,version,state,definition_version,definition_json,schema_hash,compatibility,
      published_by_type,published_by_id,published_by_name_snapshot,published_at
    ) VALUES(?,?,?,?, 'published',1,?,?,?,?,?,?,?)`)
    .bind(
      id,
      validation.definition.key,
      validation.definition.route,
      nextVersion,
      definitionJson,
      validation.schemaHash,
      compatibility,
      principal.type,
      principal.id,
      actorName(principal),
      publishedAt,
    ));

  try {
    await env.DB.batch(statements);
  } catch (error) {
    console.error(JSON.stringify({ message: "Model publication failed", modelKey: validation.definition.key, error: error instanceof Error ? error.message : String(error) }));
    throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Model publication conflicted with current registry state", 409);
  }

  const published = await getPublishedModel(env, validation.definition.key);
  if (!published || published.version !== nextVersion || published.schemaHash !== validation.schemaHash) {
    throw new ApiError("MODEL_REGISTRY_INCONSISTENT", "Published model could not be read back consistently", 500);
  }
  return published;
}

export async function retireModel(env: Bindings, key: string): Promise<void> {
  const current = await getPublishedModel(env, key);
  if (!current) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  const retiredAt = new Date().toISOString();
  const result = await env.DB.prepare(`UPDATE model_definitions SET state='retired',retired_at=? WHERE id=? AND state='published'`)
    .bind(retiredAt, current.id).run();
  if (!result.meta.changes) throw new ApiError("MODEL_PUBLICATION_CONFLICT", "Published model changed concurrently", 409);
}

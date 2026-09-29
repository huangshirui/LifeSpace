import type { Bindings } from "./env";
import type { PublishedModel } from "./model-registry";
import { allD1Batched, chunkD1Values } from "./d1-batch";
import {
  applyRelationRows,
  hydrateTypedResourceRows,
  physicalPlanFor,
  relationReadStatement,
  resourceAuditJoins,
  resourceAuditSelectColumns,
  resourcesFromRows,
  typedSelectColumns,
  typedTableSql,
  type RelationRow,
  type TypedResourceRow,
  type TypedStoredResource,
} from "./typed-resource-storage";

export async function getTypedResourcesByIds(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  ids: readonly string[],
): Promise<TypedStoredResource[]> {
  if (!ids.length) return [];
  const uniqueIds = [...new Set(ids)];
  const scalarSelect = typedSelectColumns(model);
  const statements = chunkD1Values(uniqueIds, 2).map((chunk) => env.DB.prepare(`SELECT r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at${scalarSelect ? `,${scalarSelect}` : ""}
    FROM resource_records r JOIN ${typedTableSql(model)} m ON m.record_id=r.id AND m.space_id=r.space_id
    WHERE r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL
      AND r.id IN (${chunk.map(() => "?").join(",")})`)
    .bind(spaceId, model.key, ...chunk));
  const rows = await allD1Batched<TypedResourceRow>(env.DB, statements);
  const resources = await hydrateTypedResourceRows(env, model, rows);
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  return ids.map((id) => byId.get(id)).filter((resource): resource is TypedStoredResource => Boolean(resource));
}

export type MultiModelResourceRequest = {
  model: PublishedModel;
  ids: readonly string[];
};

/**
 * Loads record state for multiple published models in one Worker -> D1 round trip.
 *
 * Batch mutation uses this instead of calling getTypedResource/getTypedResourcesByIds
 * per operation/model. Scalar reads for each model and relation hydration reads are
 * all prepared first and dispatched through one D1 batch.
 */
export async function getTypedResourcesByModels(
  env: Bindings,
  spaceId: string,
  requests: readonly MultiModelResourceRequest[],
): Promise<Map<string, TypedStoredResource>> {
  const groups = requests
    .map((request) => ({
      model: request.model,
      ids: [...new Set(request.ids.filter(Boolean))],
    }))
    .filter((request) => request.ids.length > 0);
  if (!groups.length) return new Map();

  const scalarStatements: D1PreparedStatement[] = [];
  const scalarRanges: Array<{ model: PublishedModel; start: number; count: number }> = [];
  for (const group of groups) {
    const start = scalarStatements.length;
    const scalarSelect = typedSelectColumns(group.model);
    for (const chunk of chunkD1Values(group.ids, 2)) {
      scalarStatements.push(env.DB.prepare(`SELECT
          r.id,r.space_id,r.model_key,r.model_version,r.version,r.created_at,r.updated_at,
          ${resourceAuditSelectColumns("r")}${scalarSelect ? `,${scalarSelect}` : ""}
        FROM resource_records r
        JOIN ${typedTableSql(group.model)} m
          ON m.record_id=r.id AND m.space_id=r.space_id
        ${resourceAuditJoins("r")}
        WHERE r.space_id=? AND r.model_key=? AND r.deleted_at IS NULL
          AND r.id IN (${chunk.map(() => "?").join(",")})`)
        .bind(spaceId, group.model.key, ...chunk));
    }
    scalarRanges.push({
      model: group.model,
      start,
      count: scalarStatements.length - start,
    });
  }

  const relationIds = [...new Set(groups
    .filter((group) => physicalPlanFor(group.model).relationFields.length > 0)
    .flatMap((group) => group.ids))];
  const relationStatements = relationIds.length
    ? chunkD1Values(relationIds).map((chunk) => relationReadStatement(env, chunk))
    : [];

  const results = await env.DB.batch([...scalarStatements, ...relationStatements]);
  const relationRows = results
    .slice(scalarStatements.length)
    .flatMap((result) => (result.results ?? []) as RelationRow[]);

  const output = new Map<string, TypedStoredResource>();
  for (const range of scalarRanges) {
    const rows = results
      .slice(range.start, range.start + range.count)
      .flatMap((result) => (result.results ?? []) as TypedResourceRow[]);
    const resources = resourcesFromRows(range.model, rows);
    applyRelationRows(range.model, resources, relationRows);
    for (const resource of resources) output.set(resource.id, resource);
  }
  return output;
}

import type { Bindings } from "./env";
import type { PublishedModel } from "./model-registry";
import { allD1Batched, chunkD1Values } from "./d1-batch";
import {
  hydrateTypedResourceRows,
  typedSelectColumns,
  typedTableSql,
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

import type { Bindings, Principal } from "./env";
import { allD1Batched, chunkD1Values } from "./d1-batch";
import { ApiError } from "./http";

export type ResourceAuditActor = {
  type: Principal["type"];
  id: string;
  displayName: string;
};

export type ResourceAudit = {
  createdBy: ResourceAuditActor;
  updatedBy: ResourceAuditActor;
};

export type ResourceAuditStorageRow = {
  id: string;
  created_by_type: Principal["type"];
  created_by_id: string;
  created_by_name_snapshot: string;
  created_current_name: string | null;
  updated_by_type: Principal["type"];
  updated_by_id: string;
  updated_by_name_snapshot: string;
  updated_current_name: string | null;
};

type AuditRow = { id: string } & ResourceAuditStorageRow;

export function resourceAuditActor(
  type: Principal["type"],
  id: string,
  snapshot: string,
  currentName: string | null,
): ResourceAuditActor {
  return {
    type,
    id,
    displayName: snapshot?.trim() || currentName?.trim() || id,
  };
}

function storedPrincipalType(value: unknown): value is Principal["type"] {
  return value === "user" || value === "service" || value === "device";
}

export function resourceAuditFromStorage(row: Partial<ResourceAuditStorageRow>): ResourceAudit | undefined {
  if (
    !storedPrincipalType(row.created_by_type)
    || typeof row.created_by_id !== "string"
    || typeof row.created_by_name_snapshot !== "string"
    || !storedPrincipalType(row.updated_by_type)
    || typeof row.updated_by_id !== "string"
    || typeof row.updated_by_name_snapshot !== "string"
  ) return undefined;
  return {
    createdBy: resourceAuditActor(
      row.created_by_type,
      row.created_by_id,
      row.created_by_name_snapshot,
      row.created_current_name ?? null,
    ),
    updatedBy: resourceAuditActor(
      row.updated_by_type,
      row.updated_by_id,
      row.updated_by_name_snapshot,
      row.updated_current_name ?? null,
    ),
  };
}

/**
 * Batch-load common Generic Resource audit actors for one response page.
 *
 * This intentionally performs one bounded D1 round trip for the whole result set
 * instead of looking up actors per record. Queries are split only as required by
 * D1's 100-bound-parameter ceiling and sent together with batch(). The immutable
 * name snapshot is authoritative audit presentation; an active Space Person name
 * is only a compatibility fallback for legacy rows whose snapshot could not be
 * recovered.
 */
export async function loadResourceAudits(
  env: Bindings,
  spaceId: string,
  recordIds: readonly string[],
): Promise<Map<string, ResourceAudit>> {
  const ids = [...new Set(recordIds.filter(Boolean))];
  if (!ids.length) return new Map();

  const statements = chunkD1Values(ids, 1).map((chunk) => env.DB.prepare(`SELECT
      r.id,
      r.created_by_type,r.created_by_id,r.created_by_name_snapshot,
      created_person.display_name AS created_current_name,
      r.updated_by_type,r.updated_by_id,r.updated_by_name_snapshot,
      updated_person.display_name AS updated_current_name
    FROM resource_records r
    LEFT JOIN space_people created_person
      ON r.created_by_type='user'
      AND created_person.space_id=r.space_id
      AND created_person.linked_user_id=r.created_by_id
      AND created_person.deleted_at IS NULL
    LEFT JOIN space_people updated_person
      ON r.updated_by_type='user'
      AND updated_person.space_id=r.space_id
      AND updated_person.linked_user_id=r.updated_by_id
      AND updated_person.deleted_at IS NULL
    WHERE r.space_id=? AND r.id IN (${chunk.map(() => "?").join(",")})`)
    .bind(spaceId, ...chunk));
  const rows = await allD1Batched<AuditRow>(env.DB, statements);

  const result = new Map<string, ResourceAudit>();
  for (const row of rows) {
    result.set(row.id, {
      createdBy: resourceAuditActor(
        row.created_by_type,
        row.created_by_id,
        row.created_by_name_snapshot,
        row.created_current_name,
      ),
      updatedBy: resourceAuditActor(
        row.updated_by_type,
        row.updated_by_id,
        row.updated_by_name_snapshot,
        row.updated_current_name,
      ),
    });
  }
  return result;
}

export function requireResourceAudit(
  audits: Map<string, ResourceAudit>,
  recordId: string,
): ResourceAudit {
  const audit = audits.get(recordId);
  if (!audit) throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Audit envelope is missing for resource ${recordId}`, 500);
  return audit;
}

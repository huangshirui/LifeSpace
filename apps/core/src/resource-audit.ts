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

type LegacyResourceAuditType = Exclude<Principal["type"], "agent">;

export type ResourceAuditStorageRow = {
  id: string;
  created_by_type: LegacyResourceAuditType;
  created_by_entity_type?: Principal["type"] | null;
  created_by_id: string;
  created_by_name_snapshot: string;
  created_current_name: string | null;
  updated_by_type: LegacyResourceAuditType;
  updated_by_entity_type?: Principal["type"] | null;
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

/**
 * resource_records predates Agent-as-Principal and its legacy type columns have a
 * closed SQLite CHECK. Schema 48 therefore retains those columns as compatibility
 * carriers and persists the authoritative Entity Type in additive exact columns.
 * The carrier is never exposed as business/audit truth.
 */
export function resourceAuditStorageType(type: Principal["type"]): LegacyResourceAuditType {
  return type === "agent" ? "service" : type;
}

function storedPrincipalType(value: unknown): value is Principal["type"] {
  return value === "user" || value === "service" || value === "device" || value === "agent";
}

function exactStoredType(
  exact: unknown,
  legacy: unknown,
  id: unknown,
): Principal["type"] | null {
  if (storedPrincipalType(exact)) return exact;
  if (!storedPrincipalType(legacy)) return null;
  // Compatibility fallback for typed projections that still select the pre-48
  // column subset. Schema 48 writes the exact column; the ID prefix is only a
  // representation fallback and never grants Authority.
  if (legacy === "service" && typeof id === "string" && id.startsWith("agt_")) return "agent";
  return legacy;
}

export function resourceAuditFromStorage(row: Partial<ResourceAuditStorageRow>): ResourceAudit | undefined {
  const createdType = exactStoredType(row.created_by_entity_type, row.created_by_type, row.created_by_id);
  const updatedType = exactStoredType(row.updated_by_entity_type, row.updated_by_type, row.updated_by_id);
  if (
    !createdType
    || typeof row.created_by_id !== "string"
    || typeof row.created_by_name_snapshot !== "string"
    || !updatedType
    || typeof row.updated_by_id !== "string"
    || typeof row.updated_by_name_snapshot !== "string"
  ) return undefined;
  return {
    createdBy: resourceAuditActor(
      createdType,
      row.created_by_id,
      row.created_by_name_snapshot,
      row.created_current_name ?? null,
    ),
    updatedBy: resourceAuditActor(
      updatedType,
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
      r.created_by_type,r.created_by_entity_type,r.created_by_id,r.created_by_name_snapshot,
      created_person.display_name AS created_current_name,
      r.updated_by_type,r.updated_by_entity_type,r.updated_by_id,r.updated_by_name_snapshot,
      updated_person.display_name AS updated_current_name
    FROM resource_records r
    LEFT JOIN space_people created_person
      ON COALESCE(r.created_by_entity_type,r.created_by_type)='user'
      AND created_person.space_id=r.space_id
      AND created_person.linked_user_id=r.created_by_id
      AND created_person.deleted_at IS NULL
    LEFT JOIN space_people updated_person
      ON COALESCE(r.updated_by_entity_type,r.updated_by_type)='user'
      AND updated_person.space_id=r.space_id
      AND updated_person.linked_user_id=r.updated_by_id
      AND updated_person.deleted_at IS NULL
    WHERE r.space_id=? AND r.id IN (${chunk.map(() => "?").join(",")})`)
    .bind(spaceId, ...chunk));
  const rows = await allD1Batched<AuditRow>(env.DB, statements);

  const result = new Map<string, ResourceAudit>();
  for (const row of rows) {
    const audit = resourceAuditFromStorage(row);
    if (!audit) {
      throw new ApiError("RESOURCE_STORAGE_CORRUPT", `Audit envelope is invalid for resource ${row.id}`, 500);
    }
    result.set(row.id, audit);
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

import type { Bindings } from "./env";
import { ApiError } from "./http";
import type { ModelDefinition } from "./model-definition";
import { compileCompatiblePhysicalChange, compilePhysicalSchema } from "./physical-schema";

export function physicalPublicationStatements(
  env: Bindings,
  current: ModelDefinition | null,
  next: ModelDefinition,
): D1PreparedStatement[] {
  const pendingCrudField = Object.entries(next.fields)
    .find(([, field]) => field.type === "temporal_range");
  if (pendingCrudField) {
    throw new ApiError(
      "TEMPORAL_RANGE_CRUD_NOT_READY",
      `Field ${pendingCrudField[0]} cannot be published until temporal_range CRUD hydration is implemented`,
      409,
    );
  }

  const sql = current
    ? compileCompatiblePhysicalChange(current, next).statements
    : (() => {
        const plan = compilePhysicalSchema(next);
        return [plan.createTableSql, ...plan.createIndexSql];
      })();
  return sql.map((statement) => env.DB.prepare(statement));
}

export function registryMutationGuardStatement(
  env: Bindings,
  targetRevision: number,
  mutationToken: string,
): D1PreparedStatement {
  // The publication batch starts by attempting the Registry CAS lock. D1 batch
  // results cannot be inspected until the transaction completes, so the next
  // statement turns a failed lock into a transactional failure before any DDL
  // can commit. singleton=1 already exists; if the expected revision/token is
  // not present this INSERT attempts to duplicate that primary key and aborts
  // the entire batch. If the lock succeeded, SELECT returns no rows.
  return env.DB.prepare(`INSERT INTO model_registry_state(singleton,revision,mutation_token,updated_at)
    SELECT 1,0,NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE NOT EXISTS(
      SELECT 1 FROM model_registry_state WHERE singleton=1 AND revision=? AND mutation_token=?
    )`).bind(targetRevision, mutationToken);
}

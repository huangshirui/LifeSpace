import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import type { ModelContractSnapshot } from "./model-contract";

export type StoredModelContract = ModelContractSnapshot & {
  createdBy: {
    type: Principal["type"];
    id: string;
    displayName: string;
  };
  createdAt: string;
};

type ContractRow = {
  id: string;
  contract_hash: string;
  manifest_json: string;
  openapi_json: string;
  json_schema_json: string;
  created_by_type: Principal["type"];
  created_by_id: string;
  created_by_name_snapshot: string;
  created_at: string;
};

export type ContractMutationGuard = {
  modelId: string;
  state: "published" | "retired";
  timestampColumn?: "published_at" | "retired_at";
  timestamp?: string;
};

function rowToContract(row: ContractRow): StoredModelContract {
  try {
    return {
      id: row.id,
      hash: row.contract_hash,
      manifest: JSON.parse(row.manifest_json) as ModelContractSnapshot["manifest"],
      openapi: JSON.parse(row.openapi_json) as ModelContractSnapshot["openapi"],
      jsonSchema: JSON.parse(row.json_schema_json) as ModelContractSnapshot["jsonSchema"],
      createdBy: {
        type: row.created_by_type,
        id: row.created_by_id,
        displayName: row.created_by_name_snapshot,
      },
      createdAt: row.created_at,
    };
  } catch {
    throw new ApiError("MODEL_CONTRACT_CORRUPT", `Stored model contract ${row.id} contains invalid JSON`, 500);
  }
}

function guardSql(guard: ContractMutationGuard | undefined): { sql: string; args: unknown[] } {
  if (!guard) return { sql: "1=1", args: [] };
  if (guard.timestampColumn && guard.timestamp !== undefined) {
    return {
      sql: `EXISTS(SELECT 1 FROM model_definitions WHERE id=? AND state=? AND ${guard.timestampColumn}=?)`,
      args: [guard.modelId, guard.state, guard.timestamp],
    };
  }
  return {
    sql: "EXISTS(SELECT 1 FROM model_definitions WHERE id=? AND state=?)",
    args: [guard.modelId, guard.state],
  };
}

export function modelContractMutationStatements(
  env: Bindings,
  snapshot: ModelContractSnapshot,
  principal: Principal,
  updatedAt: string,
  guard?: ContractMutationGuard,
): D1PreparedStatement[] {
  const guarded = guardSql(guard);
  const revision = env.DB.prepare(`INSERT OR IGNORE INTO model_contract_revisions(
      id,contract_hash,manifest_json,openapi_json,json_schema_json,
      created_by_type,created_by_id,created_by_name_snapshot,created_at
    ) SELECT ?,?,?,?,?,?,?,?,? WHERE ${guarded.sql}`)
    .bind(
      snapshot.id,
      snapshot.hash,
      JSON.stringify(snapshot.manifest),
      JSON.stringify(snapshot.openapi),
      JSON.stringify(snapshot.jsonSchema),
      principal.type,
      principal.id,
      principal.id,
      updatedAt,
      ...guarded.args,
    );

  const insertStateGuard = guardSql(guard);
  const insertState = env.DB.prepare(`INSERT OR IGNORE INTO model_contract_state(singleton,active_contract_id,updated_at)
      SELECT 1,?,? WHERE EXISTS(SELECT 1 FROM model_contract_revisions WHERE id=?) AND ${insertStateGuard.sql}`)
    .bind(snapshot.id, updatedAt, snapshot.id, ...insertStateGuard.args);

  const updateStateGuard = guardSql(guard);
  const updateState = env.DB.prepare(`UPDATE model_contract_state SET active_contract_id=?,updated_at=?
      WHERE singleton=1 AND EXISTS(SELECT 1 FROM model_contract_revisions WHERE id=?) AND ${updateStateGuard.sql}`)
    .bind(snapshot.id, updatedAt, snapshot.id, ...updateStateGuard.args);

  return [revision, insertState, updateState];
}

export async function persistModelContract(
  env: Bindings,
  snapshot: ModelContractSnapshot,
  principal: Principal,
  updatedAt = new Date().toISOString(),
): Promise<StoredModelContract> {
  await env.DB.batch(modelContractMutationStatements(env, snapshot, principal, updatedAt));
  const stored = await getModelContract(env, snapshot.id);
  if (!stored) throw new ApiError("MODEL_CONTRACT_STORAGE_INCONSISTENT", "Model contract could not be read back", 500);
  return stored;
}

export async function getModelContract(env: Bindings, contractId: string): Promise<StoredModelContract | null> {
  const row = await env.DB.prepare(`SELECT id,contract_hash,manifest_json,openapi_json,json_schema_json,
      created_by_type,created_by_id,created_by_name_snapshot,created_at
    FROM model_contract_revisions WHERE id=?`).bind(contractId).first<ContractRow>();
  return row ? rowToContract(row) : null;
}

export async function getActiveModelContract(env: Bindings): Promise<StoredModelContract | null> {
  const row = await env.DB.prepare(`SELECT r.id,r.contract_hash,r.manifest_json,r.openapi_json,r.json_schema_json,
      r.created_by_type,r.created_by_id,r.created_by_name_snapshot,r.created_at
    FROM model_contract_state s
    JOIN model_contract_revisions r ON r.id=s.active_contract_id
    WHERE s.singleton=1`).first<ContractRow>();
  return row ? rowToContract(row) : null;
}

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

function revisionInsert(
  env: Bindings,
  snapshot: ModelContractSnapshot,
  principal: Principal,
  createdAt: string,
  predicateSql: string,
  predicateArgs: unknown[],
): D1PreparedStatement {
  return env.DB.prepare(`INSERT OR IGNORE INTO model_contract_revisions(
      id,contract_hash,manifest_json,openapi_json,json_schema_json,
      created_by_type,created_by_id,created_by_name_snapshot,created_at
    ) SELECT ?,?,?,?,?,?,?,?,? WHERE ${predicateSql}`)
    .bind(
      snapshot.id,
      snapshot.hash,
      JSON.stringify(snapshot.manifest),
      JSON.stringify(snapshot.openapi),
      JSON.stringify(snapshot.jsonSchema),
      principal.type,
      principal.id,
      principal.id,
      createdAt,
      ...predicateArgs,
    );
}

export function modelContractMutationStatements(
  env: Bindings,
  snapshot: ModelContractSnapshot,
  principal: Principal,
  updatedAt: string,
  registryRevision: number,
  mutationToken: string,
): D1PreparedStatement[] {
  const predicate = "EXISTS(SELECT 1 FROM model_registry_state WHERE singleton=1 AND revision=? AND mutation_token=?)";
  const args = [registryRevision, mutationToken];
  const revision = revisionInsert(env, snapshot, principal, updatedAt, predicate, args);
  const insertState = env.DB.prepare(`INSERT OR IGNORE INTO model_contract_state(singleton,active_contract_id,registry_revision,updated_at)
      SELECT 1,?,?,? WHERE EXISTS(SELECT 1 FROM model_contract_revisions WHERE id=?) AND ${predicate}`)
    .bind(snapshot.id, registryRevision, updatedAt, snapshot.id, ...args);
  const updateState = env.DB.prepare(`UPDATE model_contract_state
      SET active_contract_id=?,registry_revision=?,updated_at=?
      WHERE singleton=1 AND EXISTS(SELECT 1 FROM model_contract_revisions WHERE id=?) AND ${predicate}`)
    .bind(snapshot.id, registryRevision, updatedAt, snapshot.id, ...args);
  return [revision, insertState, updateState];
}

export function initializeModelContractStatements(
  env: Bindings,
  snapshot: ModelContractSnapshot,
  principal: Principal,
  createdAt: string,
  expectedRegistryRevision: number,
): D1PreparedStatement[] {
  const predicate = `EXISTS(SELECT 1 FROM model_registry_state
    WHERE singleton=1 AND revision=? AND mutation_token IS NULL)`;
  const revision = revisionInsert(env, snapshot, principal, createdAt, predicate, [expectedRegistryRevision]);
  const state = env.DB.prepare(`INSERT OR IGNORE INTO model_contract_state(singleton,active_contract_id,registry_revision,updated_at)
      SELECT 1,?,?,? WHERE NOT EXISTS(SELECT 1 FROM model_contract_state WHERE singleton=1)
      AND EXISTS(SELECT 1 FROM model_contract_revisions WHERE id=?) AND ${predicate}`)
    .bind(snapshot.id, expectedRegistryRevision, createdAt, snapshot.id, expectedRegistryRevision);
  return [revision, state];
}

export async function getModelContract(env: Bindings, contractId: string): Promise<StoredModelContract | null> {
  const row = await env.DB.prepare(`SELECT id,contract_hash,manifest_json,openapi_json,json_schema_json,
      created_by_type,created_by_id,created_by_name_snapshot,created_at
    FROM model_contract_revisions WHERE id=?`).bind(contractId).first<ContractRow>();
  return row ? rowToContract(row) : null;
}

export async function getActiveModelContract(env: Bindings): Promise<(StoredModelContract & { registryRevision: number }) | null> {
  const row = await env.DB.prepare(`SELECT r.id,r.contract_hash,r.manifest_json,r.openapi_json,r.json_schema_json,
      r.created_by_type,r.created_by_id,r.created_by_name_snapshot,r.created_at,s.registry_revision
    FROM model_contract_state s
    JOIN model_contract_revisions r ON r.id=s.active_contract_id
    WHERE s.singleton=1`).first<ContractRow & { registry_revision: number }>();
  return row ? { ...rowToContract(row), registryRevision: row.registry_revision } : null;
}

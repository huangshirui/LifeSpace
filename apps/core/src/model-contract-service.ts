import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import { generateModelContract } from "./model-contract";
import {
  getActiveModelContract,
  getModelContract,
  initializeModelContractStatements,
  type StoredModelContract,
} from "./model-contract-store";
import { getModelRegistryRevision, listPublishedModels } from "./model-registry";

const bootstrapPrincipal: Principal = {
  type: "service",
  id: "svc_lifespace_contract_bootstrap",
  clientId: "lifespace-core",
  scopes: ["models:manage"],
  tokenId: "internal_model_contract_bootstrap",
};

export async function getOrCreateActiveModelContract(
  env: Bindings,
): Promise<StoredModelContract & { registryRevision: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getActiveModelContract(env);
    if (existing) return existing;

    const expectedRevision = await getModelRegistryRevision(env);
    const models = await listPublishedModels(env);
    const snapshot = await generateModelContract(models);
    const createdAt = new Date().toISOString();
    await env.DB.batch(initializeModelContractStatements(
      env,
      snapshot,
      bootstrapPrincipal,
      createdAt,
      expectedRevision,
    ));

    const initialized = await getActiveModelContract(env);
    if (initialized) return initialized;
  }
  throw new ApiError("MODEL_CONTRACT_CONFLICT", "Model registry changed repeatedly while initializing its contract", 409);
}

export async function readModelContract(env: Bindings, contractId: string): Promise<StoredModelContract> {
  const contract = await getModelContract(env, contractId);
  if (!contract) throw new ApiError("MODEL_CONTRACT_NOT_FOUND", "Model contract revision not found", 404);
  return contract;
}

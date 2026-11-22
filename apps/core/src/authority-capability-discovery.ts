// Protocol-neutral read-only projection of currently applicable Authority.
// Callers must derive Principal from verified LifeSpace identity, never request
// parameters. This module grants nothing and does not select a Delegation.
import { requirePersonDirectoryPermission } from "./authorization";
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import { evaluateModelAccessMany, type ModelAccessRequest } from "./model-authorization";

type Access = "read" | "write";

// A hypothetical credential Scope is permitted only for metadata discovery.
// No new JWT, data Grant, Delegation, or executable Principal is created.
export function discoveryPrincipal(principal: Principal, access: Access): Principal {
  if (access === "write" && !principal.scopes.includes("resources:write")) {
    return { ...principal, scopes: [...principal.scopes, "resources:write"] };
  }
  return principal;
}

async function personMay(env: Bindings, principal: Principal, spaceId: string, access: Access): Promise<boolean> {
  if (!principal.scopes.includes("resources:read")) return false;
  try {
    await requirePersonDirectoryPermission(env, discoveryPrincipal(principal, access), spaceId, access);
    return true;
  } catch (error) {
    if (error instanceof ApiError && [403, 404].includes(error.status)) return false;
    throw error;
  }
}

// Generic Person authority projection, shared by Account Consent and protocol
// adapters. The caller narrows the configured operations before invoking this.
export async function projectPersonAuthorityOperations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  configured: readonly string[],
): Promise<string[]> {
  const choices = [...new Set(configured.map(op => op === "list" ? "query" : op))]
    .filter(op => ["query", "get", "create", "update", "delete"].includes(op));
  if (!choices.length) return [];
  const [read, write] = await Promise.all([
    choices.some(op => op === "query" || op === "get") ? personMay(env, principal, spaceId, "read") : false,
    choices.some(op => op !== "query" && op !== "get") ? personMay(env, principal, spaceId, "write") : false,
  ]);
  return choices.filter(op => ["query", "get"].includes(op) ? read : write);
}

// Eligibility checks the verified User's *current* authority; it must not be
// mistaken for an Agent's direct execution rights or approval of a Delegation.
// The candidate list is assembled by the trusted caller and is not an identity
// assertion or a grant. Keep one batch for all model/provided-origin candidates.
export async function evaluateDelegationEligibleModels(
  env: Bindings,
  verifiedUser: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<boolean[]> {
  if (verifiedUser.type !== "user" || verifiedUser.actor || verifiedUser.purpose) {
    throw new ApiError("FORBIDDEN", "Delegation eligibility requires a verified direct User context", 403);
  }
  const evaluated = await evaluateModelAccessMany(env, verifiedUser, spaceId, requests);
  return evaluated.map(result => {
    if (result.ok) return true;
    if ([403, 404, 405].includes(result.error.status)) return false;
    throw result.error;
  });
}


import { getRuntimeModel } from "./model-registry";
import { getExternalModel, externalAuthorityModel } from "./external-model";
import { nativeFileReadFields, nativeFileUploadFields } from "./file-read-fields";

export type DelegationEligibilityCandidate = {
  modelKey: string;
  operation: string;
};
export type DelegationEligibilityResult = DelegationEligibilityCandidate & {
  requiredScopes: string[];
};

type OperationAccess = "read" | "write";
const MODEL_KEY = /^[a-z][a-z0-9_]{1,62}$/u;
const OPERATION = /^(query|get|create|update|delete|file_read|file_upload|action:[a-z][a-z0-9_-]{0,62})$/u;
const PERSON_OPERATIONS = new Set(["query", "get", "create", "update", "delete"]);

// A read-only Authority query used by independent consumer transports.
// The supplied candidate set is a *ceiling*, never executable authority.
// Core alone checks model capabilities, User permissions and active grants.
// Native/External Provider differences are resolved privately in Core.
export async function projectDelegationEligibleOperations(
  env: Bindings,
  verifiedUser: Principal,
  spaceId: string,
  candidates: readonly DelegationEligibilityCandidate[],
): Promise<DelegationEligibilityResult[]> {
  if (verifiedUser.type !== "user" || verifiedUser.actor || verifiedUser.purpose
    || !verifiedUser.scopes.includes("resources:read")) {
    throw new ApiError("FORBIDDEN", "Verified User authority is required for delegation eligibility", 403);
  }
  if (candidates.length > 128) throw new ApiError("VALIDATION_ERROR", "Too many candidate operations", 422);
  if (!candidates.length) return [];
  const unique = new Set<string>();
  const prepared: Array<{
    candidate: DelegationEligibilityCandidate;
    access: OperationAccess;
    model: ModelAccessRequest["model"];
  }> = [];
  const personCandidates: string[] = [];
  // One current Core Provider snapshot read per selected model rather than
  // one D1 lookup per operation. Revocable User authority remains uncached.
  const modelCache = new Map<string, Awaited<ReturnType<typeof getRuntimeModel>>>();
  const externalCache = new Map<string, Awaited<ReturnType<typeof getExternalModel>>>();
  for (const candidate of candidates) {
    const { modelKey, operation } = candidate;
    if (!MODEL_KEY.test(modelKey) || !OPERATION.test(operation)) {
      throw new ApiError("VALIDATION_ERROR", "Invalid candidate model operation", 422);
    }
    const id = modelKey + ":" + operation;
    if (unique.has(id)) continue;
    unique.add(id);
    let access: OperationAccess = ["query", "get", "file_read"].includes(operation) ? "read" : "write";
    if (modelKey === "person") {
      if (PERSON_OPERATIONS.has(operation) && verifiedUser.scopes.includes("resources:" + access))
        personCandidates.push(operation);
      continue;
    }
    if (!modelCache.has(modelKey)) modelCache.set(modelKey, await getRuntimeModel(env, modelKey));
    const published = modelCache.get(modelKey);
    if (!published) continue;
    const external = published.definition.origin === "external";
    // Current published Action DSL supports write/manage here, not a read
    // Action. Only explicitly writable Actions can be requested under the
    // OAuth read/write scope ceiling. Never coerce a manage Action to write.
    if (!external && operation.startsWith("action:")
      && published.definition.actions?.[operation.slice(7)]?.access !== "write") continue;
    if (!verifiedUser.scopes.includes("resources:" + access)) continue;
    let model: ModelAccessRequest["model"] = published;
    if (external) {
      if (!externalCache.has(modelKey)) externalCache.set(modelKey, await getExternalModel(env, spaceId, modelKey));
      const bound = externalCache.get(modelKey);
      if (!bound || bound.status !== "active") continue;
      const supported = ["get", "query", "create", "update", "delete"].includes(operation)
        && bound.snapshot.capabilities[operation as "get"|"query"|"create"|"update"|"delete"] === true;
      if (!supported || (access === "write" && bound.declared_access !== "write")) continue;
      model = externalAuthorityModel(bound);
    } else {
      if (operation === "file_read" && !nativeFileReadFields(published.definition).length) continue;
      if (operation === "file_upload" && !nativeFileUploadFields(published.definition).length) continue;
      if (operation.startsWith("action:")) {
        const action = published.definition.actions?.[operation.slice(7)];
        if (!action || action.access !== access) continue;
      } else if (!published.definition.access.includes(access)) continue;
    }
    prepared.push({ candidate, access, model });
  }
  const eligibility = await evaluateDelegationEligibleModels(env, verifiedUser, spaceId,
    prepared.map(item=>({model:item.model,required:item.access})));
  const authorized = prepared.filter((_item,idx)=>eligibility[idx]).map(item=>({
    modelKey: item.candidate.modelKey,
    operation: item.candidate.operation,
    requiredScopes: item.access === "read" ? ["resources:read"] : ["resources:read","resources:write"],
  }));
  if (personCandidates.length) {
    const accepted = await projectPersonAuthorityOperations(env, verifiedUser, spaceId, personCandidates);
    for (const operation of accepted) authorized.push({
      modelKey:"person",operation,
      requiredScopes: ["query", "get"].includes(operation) ? ["resources:read"] : ["resources:read","resources:write"],
    });
  }
  return authorized.sort((a,b)=>a.modelKey.localeCompare(b.modelKey)||a.operation.localeCompare(b.operation));
}

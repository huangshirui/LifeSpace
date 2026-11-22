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

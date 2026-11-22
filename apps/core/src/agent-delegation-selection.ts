// Current, explicitly selected Agent delegation authority. This helper
// belongs to Core Authority, not to a particular protocol, Runtime or Server.
import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import { delegationChainStatement, groupDelegationChainRows,
  resolveAgentApiDelegatedPrincipal, validateStructuralDelegationChain,
  type DelegationChainRow } from "./delegation-chain";

// An Agent credential authenticates the Actor, never a User. Without a
// selector its canonical direct Data Grant is used; with one the entire
// current chain must match the credential and Space, and failure is final.
export async function requireAgentDelegationSelection(
  env: Bindings, principal: Principal, spaceId: string, selector: string | undefined,
): Promise<void> {
  if (principal.type !== "agent" || principal.purpose !== "agent_api"
    || principal.actor || !principal.scopes.includes("resources:read")
    || (selector !== undefined && !/^dlg_[A-Za-z0-9_-]{1,128}$/u.test(selector))) {
    throw new ApiError("FORBIDDEN", "Authenticated Agent and valid execution selection required", 403);
  }
  if (selector === undefined) return;
  const [result] = await env.DB.batch<Record<string,unknown>>([delegationChainStatement(env, [selector])]);
  const rows = groupDelegationChainRows((result?.results ?? []) as DelegationChainRow[]).get(selector) ?? [];
  const represented = resolveAgentApiDelegatedPrincipal(principal, spaceId, selector, rows);
  validateStructuralDelegationChain(represented, spaceId, selector, rows);
}

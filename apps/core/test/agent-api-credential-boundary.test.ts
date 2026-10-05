import { describe, expect, it } from "vitest";
import { resolveAgentApiDelegatedPrincipal, type DelegationChainRow } from "../src/delegation-chain";
import type { Principal } from "../src/env";

function row(principalType: "user" | "agent" | "service" | "device", principalId: string): DelegationChainRow {
  return {
    delegation_id: "dlg_boundary",
    parent_delegation_id: null,
    remaining_redelegation_depth: 0,
    principal_type: principalType,
    principal_id: principalId,
    actor_type: "agent",
    actor_id: "agt_boundary",
    application_id: "app_boundary",
    source_space_id: "spc_boundary",
    created_by_type: "user",
    created_by_id: "usr_owner",
    delegation_revoked_at: null,
    delegation_expires_at: null,
    delegation_max_uses: null,
    delegation_consumed_at: null,
    delegation_target_type: "model",
    delegation_target_id: "task",
    delegation_target_model_key: "task",
    delegation_max_access: "write",
    selected_leaf: 1,
  };
}

describe("Agent API credential represented-principal boundary", () => {
  const credential: Principal = {
    type: "agent",
    id: "agt_boundary",
    clientId: "app_boundary",
    scopes: ["resources:read", "resources:write"],
    tokenId: "agc_boundary",
    purpose: "agent_api",
  };

  it("accepts User/Agent representation and rejects Service/Agent representation", () => {
    const represented = resolveAgentApiDelegatedPrincipal(credential, "spc_boundary", "dlg_boundary", [row("user", "usr_owner")]);
    expect(represented).toMatchObject({
      type: "user",
      id: "usr_owner",
      actor: { type: "agent", id: "agt_boundary" },
      purpose: "agent_api",
    });

    expect(() => resolveAgentApiDelegatedPrincipal(credential, "spc_boundary", "dlg_boundary", [row("service", "svc_forbidden")]))
      .toThrow(/must represent User authority/u);
  });
});

import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import type { ModelAccessDecision } from "../src/model-authorization";
import type { PublishedModel } from "../src/model-registry";
import { requireNativeFileReadPolicy } from "../src/file-routes";

function permission(principalId: string): ModelAccessDecision {
  return {
    principal: { type: "user", id: principalId, clientId: "app_synthetic", scopes: ["resources:read"] },
    policyIdentity: { principalPersonId: null, actorPersonId: null },
  } as unknown as ModelAccessDecision;
}
const readPolicyModel = {
  key: "synthetic_file_model",
  definition: {
    policies: {
      read: { op: "eq", left: { $ref: "principal.id" }, right: { value: "usr_allowed" } },
    },
  },
} as unknown as PublishedModel;

describe("Native File download Policy boundary", () => {
  it("rejects a model-readable caller denied by the model read Policy", async () => {
    // Authorization was already evaluated by the route; no DB access is needed
    // for the identity-only read Policy when ModelAccessDecision has policyIdentity.
    await expect(requireNativeFileReadPolicy(
      {} as Bindings, permission("usr_denied"), "spc_synthetic", readPolicyModel,
    )).rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });
  });

  it("allows a caller admitted by read Policy without a D1 lookup", async () => {
    await expect(requireNativeFileReadPolicy(
      {} as Bindings, permission("usr_allowed"), "spc_synthetic", readPolicyModel,
    )).resolves.toBeUndefined();
  });

  it("preserves ordinary file access for a model with no read Policy", async () => {
    await expect(requireNativeFileReadPolicy(
      {} as Bindings, permission("usr_any"), "spc_synthetic",
      { key: "synthetic_file_model", definition: {} } as PublishedModel,
    )).resolves.toBeUndefined();
  });
});

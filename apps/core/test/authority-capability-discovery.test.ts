import { describe, expect, it } from "vitest";
import { discoveryPrincipal, evaluateDelegationEligibleModels, projectPersonAuthorityOperations } from "../src/authority-capability-discovery";
import type { Bindings, Principal } from "../src/env";
import type { ExternalModel } from "../src/external-model";
import { externalFileUploadFields } from "../src/file-read-fields";

const user: Principal = {
  type: "user",
  id: "usr_synthetic",
  clientId: "app_synthetic",
  tokenId: "tok_synthetic",
  scopes: ["resources:read"],
};
const env = {} as Bindings;

describe("protocol-neutral authorization capability discovery", () => {
  it("does not mistake an Agent or a represented User for an approving User", async () => {
    await expect(evaluateDelegationEligibleModels(env, { ...user, type: "agent" }, "spc_synthetic", []))
      .rejects.toMatchObject({ status: 403 });
    await expect(evaluateDelegationEligibleModels(env, {
      ...user, actor: { type: "agent", id: "agt_synthetic" },
    }, "spc_synthetic", [])).rejects.toMatchObject({ status: 403 });
    await expect(evaluateDelegationEligibleModels(env, { ...user, purpose: "oauth_agent_execution" }, "spc_synthetic", []))
      .rejects.toMatchObject({ status: 403 });
  });

  it("does not create rights or query storage when no candidates were selected", async () => {
    await expect(evaluateDelegationEligibleModels(env, user, "spc_synthetic", [])).resolves.toEqual([]);
    await expect(projectPersonAuthorityOperations(env, user, "spc_synthetic", [])).resolves.toEqual([]);
  });

  it("keeps hypothetical credential scope separate from executable identity", () => {
    const projected = discoveryPrincipal(user, "write");
    expect(projected.scopes).toContain("resources:write");
    expect(user.scopes).not.toContain("resources:write");
    expect(projected.type).toBe("user");
    expect(projected.id).toBe(user.id);
  });
  it("projects only actually writable Provider file fields without inventing External download", () => {
    const external = {
      declared_access: "write",
      snapshot: {fields:[
        {key:"zeta",type:"file_ref_list",writable:true,upload:{supported:true,maxBytes:1024}},
        {key:"alpha",type:"file_ref_list",writable:true,upload:{supported:true,maxBytes:1024}},
        {key:"readOnly",type:"file_ref_list",writable:false,upload:{supported:true,maxBytes:1024}},
        {key:"immutable",type:"file_ref_list",writable:true,readOnly:true,upload:{supported:true,maxBytes:1024}},
        {key:"ordinary",type:"file_ref_list",writable:true},
        {key:"scalar",type:"string",writable:true,upload:{supported:true,maxBytes:1024}},
      ]},
    } as unknown as ExternalModel;
    expect(externalFileUploadFields(external)).toEqual(["alpha","zeta"]);
    expect(externalFileUploadFields({...external,declared_access:"read"})).toEqual([]);
  });

});

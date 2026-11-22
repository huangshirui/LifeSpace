import { describe, expect, it } from "vitest";
import { discoveryPrincipal, evaluateDelegationEligibleModels, projectPersonAuthorityOperations } from "../src/authority-capability-discovery";
import type { Bindings, Principal } from "../src/env";
import type { ExternalModel } from "../src/external-model";
import { externalFileUploadFields, externalFileReadFields } from "../src/file-read-fields";

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
  it("supports Provider file read and separate upload capability on readonly fields", () => {
    const external = {
      status: "active", declared_access: "write",
      snapshot: {capabilities:{get:true},fields:[
        {key:"zeta",type:"file_ref_list",readable:true,writable:true,upload:{supported:true,maxBytes:1024}},
        {key:"alpha",type:"file_ref_list",readable:true,writable:true,upload:{supported:true,maxBytes:1024}},
        {key:"readOnly",type:"file_ref_list",readable:true,writable:false,readOnly:true,upload:{supported:true,maxBytes:1024}},
        {key:"ordinary",type:"file_ref_list",readable:true,writable:false},
        {key:"scalar",type:"string",readable:true,writable:true,upload:{supported:true,maxBytes:1024}},
      ]},
    } as unknown as ExternalModel;
    expect(externalFileUploadFields(external)).toEqual(["alpha","readOnly","zeta"]);
    expect(externalFileReadFields(external)).toEqual(["alpha","ordinary","readOnly","zeta"]);
    expect(externalFileUploadFields({...external,declared_access:"read"})).toEqual([]);
    expect(externalFileReadFields({...external,declared_access:"read"})).toHaveLength(4);
    expect(externalFileReadFields({...external,status:"degraded"})).toEqual([]);
    expect(externalFileReadFields({...external,snapshot:{...external.snapshot,capabilities:{...external.snapshot.capabilities,get:false}}})).toEqual([]);
  });

});

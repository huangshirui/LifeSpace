import { describe, expect, it } from "vitest";
import { allowedMcpQueryModels, allowedMcpToolModels, configuredMcpOAuthScopes, oauthMcpServerId, currentMcpOAuthQueryPolicy } from "../src/mcp-oauth-server-policy";

describe("Core-owned MCP Server resource and operation boundary", () => {
  const id = "mcp_" + "a".repeat(32);
  it("accepts exactly one Core-generated server id in HTTPS OAuth resource path", () => {
    expect(oauthMcpServerId("https://core.example.test/mcp/" + id)).toBe(id);
    for (const invalid of [
      "https://core.example.test/mcp",
      "https://core.example.test/mcp/not-an-id",
      "https://core.example.test/mcp/" + id + "/",
      "https://core.example.test/mcp/" + id + "?debug=1",
      "https://core.example.test/mcp/" + id + "#fragment",
      "https://core.example.test/mcp/" + id + "/../evil",
      "http://core.example.test/mcp/" + id,
      "https://user:pass@core.example.test/mcp/" + id,
      "https://core.example.test/mcp/" + "A".repeat(32),
    ]) expect(oauthMcpServerId(invalid)).toBeNull();
  });

  it("only selects configured query operations; non-query/read-only do not leak", () => {
    expect(allowedMcpQueryModels(JSON.stringify({ models: [
      { modelKey: "task", operations: ["query", "get"] },
      { modelKey: "activity", operations: ["get"] },
      { modelKey: "event", operations: ["query", "create"] },
    ], resources: [{ resourceKey: "person_directory", operations: ["list"] }] })))
      .toEqual(["event", "task"]);
  });

  it("discovers Get-only and mutation-only models but never grants unconfigured Query", () => {
    const config = JSON.stringify({ models: [
      { modelKey: "task", operations: ["query"] },
      { modelKey: "activity", operations: ["get"] },
      { modelKey: "anniversary", operations: ["create"] },
      { modelKey: "event", operations: ["action:close"] },
    ] });
    expect(allowedMcpQueryModels(config)).toEqual(["task"]);
    // Explicit Action-only Models are also genuine selected MCP tools.
    expect(allowedMcpToolModels(config)).toEqual(["activity", "anniversary", "event", "task"]);
    expect(configuredMcpOAuthScopes(config)).toEqual(["resources:read", "resources:write"]);
  });

  it("treats a selected External CRUD operation exactly as an ordinary model, without bypassing Server restrictions", async () => {
    const modelKey="ext_"+"c".repeat(32);
    const cfg=JSON.stringify({models:[{modelKey,operations:["query","get","update"]}]});
    const db={
      prepare:(_query:string)=>({
        bind:(_id:string)=>({
          first:async()=>({enabled:1,config_json:cfg}),
        }),
      }),
    } as unknown as D1Database;
    const origin="https://core.example.test/mcp/"+id;
    const base="/api/v1/spaces/spc_example/models/"+modelKey+"/records";
    await expect(currentMcpOAuthQueryPolicy(db,origin,"PATCH",base+"/rec_external_example"))
      .resolves.toMatchObject({modelOperations:{[modelKey]:["query","get","update"]}});
    await expect(currentMcpOAuthQueryPolicy(db,origin,"POST",base)).rejects.toMatchObject({status:403});
    await expect(currentMcpOAuthQueryPolicy(db,origin,"DELETE",base+"/rec_external_example"))
      .rejects.toMatchObject({status:403});
    // This is a Server allowlist check, never proof that the Provider
    // supports the operation or that the caller holds write Data Grant.
  });

  it("fails closed on malformed or duplicate selected model configuration", () => {
    for (const bad of [
      "{",
      "null",
      "{}",
      JSON.stringify({ models: [{ modelKey: "task", operations: ["query"] }, { modelKey: "task", operations: ["query"] }] }),
      JSON.stringify({ models: [{ modelKey: "Task", operations: ["query"] }] }),
      JSON.stringify({ models: [{ modelKey: "task", operations: ["query", 1] }] }),
      JSON.stringify({ models: new Array(33).fill({ modelKey: "task", operations: ["query"] }) }),
    ]) expect(() => allowedMcpQueryModels(bad)).toThrow();
  });
});

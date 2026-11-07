import { describe, expect, it } from "vitest";
import { allowedMcpQueryModels, oauthMcpServerId } from "../src/mcp-oauth-server-policy";

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

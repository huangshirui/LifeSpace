import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { configuredOAuthResource, liveOAuthResource } from "../src/oauth-mcp-resource";

const origin = "https://core-staging.aisr.online";
const first = origin + "/mcp/mcp_" + "a".repeat(32);
const second = origin + "/mcp/mcp_" + "b".repeat(32);

describe("Identity Core-owned dynamic OAuth Resource trust", () => {
  it("requires one exact canonical environment origin and issued-ID grammar", () => {
    const configured = {
      ENVIRONMENT: "staging", OAUTH_MCP_RESOURCE_ORIGIN: origin,
    } as Bindings;
    expect(configuredOAuthResource(configured, first)).toBe(first);
    expect(configuredOAuthResource(configured, second)).toBe(second);
    for (const input of [
      "https://core.aisr.online/mcp/mcp_" + "a".repeat(32),
      origin + "/mcp", origin + "/mcp/mcp_fake",
      first + "?redirect=https://evil.test",
      first + "#fragment",
      first.replace("https:", "http:"),
      first.replace("mcp_", "mcp_X"),
      "https://user:pass@core-staging.aisr.online/mcp/mcp_" + "a".repeat(32),
    ]) {
      expect(configuredOAuthResource(configured, input)).toBeNull();
    }
    expect(configuredOAuthResource({
      ...configured, OAUTH_MCP_RESOURCE_ORIGIN: "https://evil.test",
    }, first)).toBeNull();
  });

  it("checks enabled Server status with private Core before creating Consent", async () => {
    const calls: string[] = [];
    let active = true;
    const env = {
      ENVIRONMENT: "staging",
      OAUTH_MCP_RESOURCE_ORIGIN: origin,
      CORE_IDENTITY_SHARED_SECRET: "trusted-internal-core-identity-secret",
      CORE: { fetch: async (_url: string, init: RequestInit) => {
        expect(new Headers(init.headers).get("x-lifespace-internal-secret"))
          .toBe("trusted-internal-core-identity-secret");
        const resource = JSON.parse(String(init.body)).resource as string;
        calls.push(resource);
        return Response.json({ data: {
          active, resource,
        } });
      } },
    } as unknown as Bindings;
    expect(await liveOAuthResource(env, first)).toBe(true);
    expect(await liveOAuthResource(env, second)).toBe(true);
    expect(calls).toEqual([first, second]);
    active = false;
    expect(await liveOAuthResource(env, first)).toBe(false);
    expect(await liveOAuthResource(env, origin + "/mcp/mcp_bad")).toBe(false);
    expect(calls).toHaveLength(3);
    expect(await liveOAuthResource({
      ...env, CORE: undefined,
    }, first)).toBe(false);
    expect(await liveOAuthResource({
      ...env, CORE_IDENTITY_SHARED_SECRET: "",
    }, first)).toBe(false);
  });

  it("keeps fixed allowlisted synthetic Resources independent of Core", async () => {
    const legacy = "https://mcp.example.test/mcp/tasks";
    const env = { OAUTH_ALLOWED_RESOURCES: legacy } as Bindings;
    expect(configuredOAuthResource(env, legacy)).toBe(legacy);
    expect(await liveOAuthResource(env, legacy)).toBe(true);
    expect(await liveOAuthResource(env, first)).toBe(false);
  });
});

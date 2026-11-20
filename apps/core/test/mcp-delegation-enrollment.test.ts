import { describe, expect, it } from "vitest";
import {
  parseMcpDelegationAgents, parseMcpDelegationContexts,
  includesMcpOAuthEnrollment,
} from "../src/mcp-delegation-contexts";

const pair = { applicationId: "app_synthetic", agentId: "agt_synthetic" };
const context = { ...pair, spaceId: "spc_synthetic" };

describe("MCP Server OAuth delegation enrollment", () => {
  it("normalizes Space-independent Agent pairs without assigning any Space authority", () => {
    const admission = {
      agents: parseMcpDelegationAgents([pair]),
      contexts: parseMcpDelegationContexts(undefined),
    };
    expect(admission.agents).toEqual([pair]);
    expect(admission.contexts).toEqual([]);
    expect(includesMcpOAuthEnrollment(admission, context)).toBe(true);
    expect(includesMcpOAuthEnrollment(admission, { ...context, agentId: "agt_other" })).toBe(false);
    expect(includesMcpOAuthEnrollment(admission, { ...context, applicationId: "app_other" })).toBe(false);
  });

  it("retains existing exact Space enrollment and rejects unknown pairs", () => {
    const admission = {
      agents: parseMcpDelegationAgents(undefined),
      contexts: parseMcpDelegationContexts([context]),
    };
    expect(includesMcpOAuthEnrollment(admission, context)).toBe(true);
    expect(includesMcpOAuthEnrollment(admission, { ...context, spaceId: "spc_other" })).toBe(false);
  });

  it("rejects malformed, duplicated, oversized and client-supplied Space authority fields", () => {
    for (const value of [
      null, {}, "all", [{ ...pair, spaceId: "spc_unbounded" }], [pair, pair],
      [pair, { ...pair, agentId: "bad-agent" }],
      Array.from({ length: 33 }, (_, i) => ({ ...pair, agentId: "agt_" + i })),
    ]) expect(() => parseMcpDelegationAgents(value)).toThrow();
    expect(parseMcpDelegationAgents([])).toEqual([]);
    expect(() => parseMcpDelegationAgents([pair, { ...pair, applicationId: "app_other" }])).not.toThrow();
  });
});

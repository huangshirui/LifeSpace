import { describe, expect, it } from "vitest";
import {
  dcrRedirectUri, mayRegisterDcr, mayUseCimd, callbackAllowed,
  validateOAuthClientAdmissionPolicy, type OAuthClientAdmissionPolicy,
} from "../src/oauth-client-admission-policy";

const example = {
  cimdEnabled: true,
  dcrEnabled: true,
  callbackUris: [] as string[],
};
const saved = (policy: typeof example): OAuthClientAdmissionPolicy => ({
  ...policy, revision: 3, updatedAt: "2026-11-07T00:00:00Z",
});

describe("simple OAuth Console controls", () => {
  it("accepts only two switches and an optional exact callback list", () => {
    expect(validateOAuthClientAdmissionPolicy(example)).toEqual(example);
    for (const bad of [
      { ...example, cimdMode: "restricted" },
      { ...example, dcrRedirectUris: [] },
      { ...example, callbackMode: "restricted" },
      { ...example, callbackUris: ["https://*.example.com/cb"] },
      { ...example, callbackUris: ["http://evil.example.com/cb"] },
      { ...example, callbackUris: ["https://127.0.0.1/cb"] },
      { ...example, callbackUris: ["https://a.example.com/cb", "https://a.example.com/cb"] },
      { ...example, callbackUris: Array.from({ length: 101 }, (_, i) => "https://a.example.com/cb/" + i) },
      { ...example, callbackUris: "https://chatgpt.com/cb" },
    ]) expect(validateOAuthClientAdmissionPolicy(bad)).toBeNull();
    expect(validateOAuthClientAdmissionPolicy({
      cimdEnabled: false, dcrEnabled: false, callbackUris: [],
    })).not.toBeNull();
  });

  it("enables safe client discovery and DCR without pre-registering callbacks in Console", () => {
    const policy = saved(example);
    expect(mayUseCimd(policy, "https://client.example.com/oauth/client.json")).toBe(true);
    expect(mayUseCimd(policy, "http://localhost/cimd")).toBe(false);
    expect(mayRegisterDcr(policy, ["https://new-client.example.com/callback"])).toBe(true);
    expect(mayRegisterDcr(policy, ["https://new-client.example.com/callback", "https://127.0.0.1/cb"])).toBe(false);
    expect(dcrRedirectUri("http://127.0.0.1:12345/callback")).toBe(true);
    expect(dcrRedirectUri("http://localhost:4567/callback")).toBe(true);
    expect(callbackAllowed(policy, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(callbackAllowed(policy, "https://*.example.com/callback")).toBe(false);
    expect(mayUseCimd({ ...policy, cimdEnabled: false }, "https://client.example.com/oauth/client.json")).toBe(false);
    expect(mayRegisterDcr({ ...policy, dcrEnabled: false }, ["https://client.example.com/cb"])).toBe(false);
  });

  it("non-empty Allowed callback URLs adds a shared restriction without replacing exact client callback checks", () => {
    const policy = saved({
      ...example,
      callbackUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    expect(callbackAllowed(policy, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(callbackAllowed(policy, "https://chatgpt.com/connector/oauth/other")).toBe(false);
    expect(mayUseCimd(policy, "https://client.example.com/oauth/client.json")).toBe(true);
    expect(mayRegisterDcr(policy, ["https://client.example.com/callback"])).toBe(true);
  });
});

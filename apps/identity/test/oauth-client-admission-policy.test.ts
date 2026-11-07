import { describe, expect, it } from "vitest";
import {
  dcrRedirectUri, mayRegisterDcr, mayUseCimd, callbackAllowed,
  validateOAuthClientAdmissionPolicy, type OAuthClientAdmissionPolicy,
} from "../src/oauth-client-admission-policy";

const example = {
  cimdEnabled: true,
  dcrEnabled: true,
  cimdMode: "restricted" as const,
  dcrMode: "restricted" as const,
  callbackMode: "client" as const,
  cimdClientIds: ["https://chatgpt.com/oauth/client.json"],
  dcrRedirectUris: ["https://chatgpt.com/connector/oauth/50_CFoh9OsZj"],
  callbackUris: [] as string[],
};
const saved = (policy: typeof example): OAuthClientAdmissionPolicy =>
  ({ ...policy, revision: 1, updatedAt: "2026-11-07T00:00:00Z" });

describe("platform admission is separate from user OAuth authorization", () => {
  it("preserves strict existing policy and rejects unsafe rules", () => {
    expect(validateOAuthClientAdmissionPolicy(example)).toEqual(example);
    for (const invalid of [
      { ...example, cimdClientIds: [] },
      { ...example, dcrRedirectUris: [] },
      { ...example, cimdClientIds: ["https://*.example.com/client.json"] },
      { ...example, cimdClientIds: ["https://127.0.0.1/private.json"] },
      { ...example, dcrRedirectUris: ["https://*.example.com/cb"] },
      { ...example, dcrRedirectUris: ["http://evil.example.com/cb"] },
      { ...example, dcrRedirectUris: ["https://10.0.0.1/cb"] },
      { ...example, dcrRedirectUris: [...example.dcrRedirectUris, ...example.dcrRedirectUris] },
      { ...example, callbackMode: "restricted", callbackUris: [] },
      { ...example, callbackUris: ["https://*.example.com/cb"] },
      { ...example, callbackUris: ["https://a.example.com/cb", "https://a.example.com/cb"] },
      { ...example, cimdMode: "all" },
      { ...example, dcrMode: "all" },
      { ...example, unknown: true },
    ]) expect(validateOAuthClientAdmissionPolicy(invalid)).toBeNull();
    expect(dcrRedirectUri("http://127.0.0.1:12345/cb")).toBe(true);
    expect(dcrRedirectUri("http://localhost:4567/cb")).toBe(true);
    expect(dcrRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
  });

  it("allows bounded automatic client admission without administrator callbacks", () => {
    const open = {
      ...example,
      cimdMode: "open" as const,
      dcrMode: "open" as const,
      cimdClientIds: [],
      dcrRedirectUris: [],
    };
    expect(validateOAuthClientAdmissionPolicy(open)).toEqual(open);
    const policy = saved(open);
    expect(mayUseCimd(policy, "https://client.example.com/oauth/client.json")).toBe(true);
    expect(mayUseCimd(policy, "http://127.0.0.1/doc.json")).toBe(false);
    expect(mayRegisterDcr(policy, ["https://new-client.example.com/cb"])).toBe(true);
    expect(mayRegisterDcr(policy, ["https://new-client.example.com/cb", "https://127.0.0.1/cb"])).toBe(false);
    expect(callbackAllowed(policy, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(callbackAllowed(policy, "https://*.example.com/cb")).toBe(false);
  });

  it("optional global callback restriction applies to CIMD, DCR and pre-registered clients", () => {
    const policy = saved({
      ...example,
      callbackMode: "restricted",
      callbackUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
    });
    expect(callbackAllowed(policy, "https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
    expect(callbackAllowed(policy, example.dcrRedirectUris[0])).toBe(false);
    expect(mayUseCimd(policy, example.cimdClientIds[0])).toBe(true);
    expect(mayRegisterDcr(policy, example.dcrRedirectUris)).toBe(true);
    expect(mayUseCimd({ ...policy, cimdEnabled: false }, example.cimdClientIds[0])).toBe(false);
    expect(mayRegisterDcr({ ...policy, dcrEnabled: false }, example.dcrRedirectUris)).toBe(false);
  });
});

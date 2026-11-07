import { describe, expect, it } from "vitest";
import {
  dcrRedirectUri, mayRegisterDcr, mayUseCimd, validateOAuthClientAdmissionPolicy,
  type OAuthClientAdmissionPolicy,
} from "../src/oauth-client-admission-policy";

const good = {
  cimdEnabled: true, dcrEnabled: true,
  cimdClientIds: ["https://chatgpt.com/oauth/client.json"],
  dcrRedirectUris: ["https://chatgpt.com/connector/oauth/50_CFoh9OsZj"],
};

describe("Identity-owned Console OAuth client admission policy", () => {
  it("accepts exact public URLs and refuses open/wildcard/private rules", () => {
    expect(validateOAuthClientAdmissionPolicy(good)).toEqual(good);
    for (const invalid of [
      { ...good, cimdClientIds: ["https://*.example.com/client.json"] },
      { ...good, cimdClientIds: ["https://127.0.0.1/private.json"] },
      { ...good, cimdClientIds: [] },
      { ...good, dcrRedirectUris: [] },
      { ...good, dcrRedirectUris: ["https://*.example.com/cb"] },
      { ...good, dcrRedirectUris: ["http://evil.example.com/cb"] },
      { ...good, dcrRedirectUris: ["http://localhost:8000/cb"] },
      { ...good, dcrRedirectUris: [good.dcrRedirectUris[0], good.dcrRedirectUris[0]] },
      { ...good, cimdClientIds: [good.cimdClientIds[0], good.cimdClientIds[0]] },
      { ...good, unexpected: true },
    ]) expect(validateOAuthClientAdmissionPolicy(invalid)).toBeNull();
    expect(validateOAuthClientAdmissionPolicy({
      cimdEnabled: false, dcrEnabled: false, cimdClientIds: [], dcrRedirectUris: [],
    })).not.toBeNull();
    expect(dcrRedirectUri("http://127.0.0.1:12345/cb")).toBe(true);
  });

  it("never mistakes registration allowlist entries for a client identity", () => {
    const policy: OAuthClientAdmissionPolicy = { ...good, revision: 1, updatedAt: "2026-11-07T00:00:00Z" };
    expect(mayUseCimd(policy, good.cimdClientIds[0])).toBe(true);
    expect(mayUseCimd(policy, "https://chatgpt.com/oauth/other.json")).toBe(false);
    expect(mayRegisterDcr(policy, good.dcrRedirectUris)).toBe(true);
    expect(mayRegisterDcr(policy, [...good.dcrRedirectUris, "https://evil.example.com/cb"])).toBe(false);
    expect(mayRegisterDcr({ ...policy, dcrEnabled: false }, good.dcrRedirectUris)).toBe(false);
    expect(mayUseCimd({ ...policy, cimdEnabled: false }, good.cimdClientIds[0])).toBe(false);
  });
});

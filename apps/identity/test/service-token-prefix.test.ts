import { describe, expect, it } from "vitest";
import { isOpaqueServiceApiToken } from "../src/service-auth";

describe("Service API Token prefix compatibility", () => {
  it("accepts canonical and legacy opaque prefixes", () => {
    expect(isOpaqueServiceApiToken("lsp_svc_example")).toBe(true);
    expect(isOpaqueServiceApiToken("lsp_pat_example")).toBe(true);
    expect(isOpaqueServiceApiToken("lsa_example")).toBe(false);
  });
});

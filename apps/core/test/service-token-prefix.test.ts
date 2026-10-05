import { describe, expect, it } from "vitest";
import { isOpaqueServiceApiToken } from "../src/auth";

describe("Core opaque Service API Token classification", () => {
  it("routes canonical and legacy prefixes to Identity introspection", () => {
    expect(isOpaqueServiceApiToken("lsp_svc_example")).toBe(true);
    expect(isOpaqueServiceApiToken("lsp_pat_example")).toBe(true);
    expect(isOpaqueServiceApiToken("eyJ.fake.jwt")).toBe(false);
  });
});

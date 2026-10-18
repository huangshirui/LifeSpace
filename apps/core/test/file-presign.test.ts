import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import { presignR2Object } from "../src/file-routes";

describe("R2 File transfer signing", () => {
  it("creates a key-scoped short-lived SigV4 query URL without exposing credentials", async () => {
    const env={ ENVIRONMENT:"staging", R2_S3_ACCOUNT_ID:"0123456789abcdef0123456789abcdef", R2_S3_ACCESS_KEY_ID:"access-key", R2_S3_SECRET_ACCESS_KEY:"secret-key-secret-key-secret-key" } as Bindings;
    const url=await presignR2Object(env,"uploads/external/spc_test/upl_test","PUT",60,"application/pdf");
    expect(url).toContain("lifespace-staging-assets/uploads/external/spc_test/upl_test");
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain("X-Amz-Expires=60");
    expect(url).not.toContain("secret-key-secret-key");
  });
  it("never signs a PUT to a permanent Native File object", async () => {
    const env={ ENVIRONMENT:"staging", R2_S3_ACCOUNT_ID:"0123456789abcdef0123456789abcdef", R2_S3_ACCESS_KEY_ID:"access-key", R2_S3_SECRET_ACCESS_KEY:"secret-key-secret-key-secret-key" } as Bindings;
    await expect(presignR2Object(env,"files/spc_test/fil_test","PUT",900,"application/pdf"))
      .rejects.toMatchObject({code:"INVALID_REQUEST"});
    const url=await presignR2Object(env,"uploads/native/spc_test/upl_test","PUT",900,"application/pdf");
    expect(url).toContain("/uploads/native/spc_test/upl_test");
    expect(url).not.toContain("/files/spc_test/");
  });
});

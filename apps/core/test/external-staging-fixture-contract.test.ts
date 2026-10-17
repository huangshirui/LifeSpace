import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const smoke = readFileSync(new URL("../../../infra/scripts/verify-staging-external-self-service.mjs", import.meta.url), "utf8");
const rollout = readFileSync(new URL("../../../infra/external-provider-rollout.md", import.meta.url), "utf8");

describe("External staging fixture contract", () => {
  it("does not require a manually created Notion unique_id field", () => {
    expect(smoke).not.toContain("uniqueIdTitle");
    expect(smoke).not.toContain("must contain one Notion ID/unique_id property");
    expect(rollout).toContain("A Notion `unique_id` / ID property is **optional**");
  });
});

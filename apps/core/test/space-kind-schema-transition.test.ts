import { describe, expect, it } from "vitest";
import { retiredSpaceKindStorageRequired } from "../src/spaces";

describe("Space.kind storage cutover bridge", () => {
  it("uses the retired storage column only on schema44", () => {
    expect(retiredSpaceKindStorageRequired(44)).toBe(true);
    expect(retiredSpaceKindStorageRequired(45)).toBe(false);
    expect(retiredSpaceKindStorageRequired(46)).toBe(false);
  });

  it("fails closed if Core 0.39 is pointed at a pre-bridge schema", () => {
    expect(() => retiredSpaceKindStorageRequired(43)).toThrow(/requires schema >=44/u);
  });
});

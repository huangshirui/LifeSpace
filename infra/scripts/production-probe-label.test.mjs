import assert from "node:assert/strict";
import test from "node:test";
import { boundedProbeLabel } from "./production-probe-label.mjs";

test("keeps production probe labels within Identity user displayName limit", () => {
  const label = boundedProbeLabel("Phase6 model probe", "run_" + "1234567890".repeat(10), 50);
  assert.equal(label.length <= 50, true);
  assert.equal(label.startsWith("Phase6 model probe "), true);
  assert.equal(label.endsWith("1234567890"), true);
});

test("preserves ordinary short probe IDs", () => {
  assert.equal(boundedProbeLabel("Phase6 model probe", "31775638087_1", 50), "Phase6 model probe 31775638087_1");
});

test("rejects prefixes that cannot leave room for a probe suffix", () => {
  assert.throws(() => boundedProbeLabel("x".repeat(50), "probe", 50));
});

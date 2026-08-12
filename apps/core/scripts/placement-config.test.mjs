import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("deployed Core environments use Smart Placement", () => {
  assert.deepEqual(config.env?.staging?.placement, { mode: "smart" });
  assert.deepEqual(config.env?.production?.placement, { mode: "smart" });
});

test("local Core keeps default local placement behavior", () => {
  assert.equal(config.placement, undefined);
});

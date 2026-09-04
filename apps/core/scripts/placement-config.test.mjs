import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("deployed Core environments use Smart Placement", () => {
  assert.deepEqual(config.env?.staging?.placement, { mode: "smart" });
  assert.deepEqual(config.env?.production?.placement, { mode: "smart" });
});

test("Core public HTTP egress routes through the public Cloudflare edge", () => {
  assert.deepEqual(config.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.equal(config.env?.staging?.compatibility_flags, undefined);
  assert.equal(config.env?.production?.compatibility_flags, undefined);
});

test("local Core keeps default local placement behavior", () => {
  assert.equal(config.placement, undefined);
});
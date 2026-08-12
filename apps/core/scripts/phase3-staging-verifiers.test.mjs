import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scripts = [
  new URL("../../../infra/scripts/verify-phase3-staging-db.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-phase3-staging-http.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-phase3-staging-models.mjs", import.meta.url),
  new URL("../../../infra/scripts/verify-phase3-staging-creation-draft.mjs", import.meta.url),
];

test("Phase 3 staging verifier scripts remain valid Node syntax", () => {
  for (const script of scripts) {
    const path = fileURLToPath(script);
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ["--check", path], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }, `node --check failed for ${path}`);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";

const modelAdminVerifier = new URL("./verify-production-model-admin.mjs", import.meta.url);

test("production proving models pin semantic identity without assuming environment-local Registry versions", () => {
  const wish = PRODUCTION_PROVING_MODELS.find((model) => model.key === "wish");
  assert.ok(wish, "Wish must remain a production proving model");
  assert.equal(wish.minimumVersion, 4, "Wish clean-release version remains the production Registry floor");
  assert.equal(
    wish.hash,
    "6b7d10124504a08bc906bba5915a1ba050e09865039b991dfd470019be879f56",
    "production must pin the authoritative two-state Wish schema hash",
  );
  assert.equal("version" in wish, false, "production must not assume one exact environment-local Wish Registry version");
});

test("production Model Contract verification matches the current published Registry snapshot exactly", () => {
  const source = readFileSync(fileURLToPath(modelAdminVerifier), "utf8");

  assert.match(source, /actualVersion < expected\.minimumVersion/u, "published production models must satisfy the release floor");
  assert.match(source, /actual\.schemaHash !== expected\.hash/u, "published production models must keep exact schema identity");
  assert.match(source, /currentPublishedModels/u, "production verification must remember actual environment-local published versions");
  assert.match(source, /Number\(model\.version\) !== published\.version/u, "active Model Contract must pin the exact current Registry version");
  assert.match(source, /model\.schemaHash !== published\.schemaHash/u, "active Model Contract must pin the exact current schema hash");
  assert.match(source, /publishedVersion <= currentVersion/u, "semantic reconciliation must remain monotonic");
  assert.match(source, /publishedVersion < expected\.minimumVersion/u, "semantic reconciliation must not publish below the release floor");
  assert.doesNotMatch(source, /expected\.version\s*-\s*1/u, "production must not assume a fixed predecessor version");
  assert.doesNotMatch(source, /Number\(actual\.version\) !== expected\.version/u, "production must not require one exact environment-local published version");
});

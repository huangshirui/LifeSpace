import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = [
  new URL("../../../infra/scripts/prepare-staging-smoke.mjs", import.meta.url),
  new URL("../../../infra/scripts/cleanup-staging-smoke.mjs", import.meta.url),
];

test("authenticated staging smoke scripts remain syntax-valid and staging-only", () => {
  for (const url of scripts) {
    const filename = fileURLToPath(url);
    const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, `${filename} failed node --check: ${result.stderr || result.stdout}`);

    const source = readFileSync(filename, "utf8");
    assert.match(source, /staging/u, `${filename} must remain explicitly staging-scoped`);
    assert.doesNotMatch(source, /--env[\s"',]+production/u, `${filename} must never target Wrangler production`);
    assert.doesNotMatch(source, /core\.aisr\.online/u, `${filename} must never target the production Core hostname`);
    assert.doesNotMatch(source, /auth\.aisr\.online/u, `${filename} must never target the production Identity hostname`);
  }
});

test("staging bootstrap masks ephemeral credentials before job export", () => {
  const source = readFileSync(fileURLToPath(scripts[0]), "utf8");
  assert.match(source, /::add-mask::/u);
  assert.match(source, /GITHUB_ENV/u);
  assert.match(source, /15 \* 60 \* 1000/u, "service PAT should retain a bounded staging-only lifetime");
  assert.match(source, /application_model_access/u, "smoke app model authorization must be explicit");
});

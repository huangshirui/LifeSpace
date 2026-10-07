import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = new URL("../../../infra/scripts/verify-staging-platform-golden-flow.mjs", import.meta.url);
const workflow = new URL("../../../.github/workflows/staging-deploy.yml", import.meta.url);

test("platform Golden Flow verifier remains syntax-valid, staging-only and release-bounded", () => {
  const filename = fileURLToPath(verifier);
  const syntax = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  assert.equal(syntax.status, 0, `${filename} failed node --check: ${syntax.stderr || syntax.stdout}`);

  const source = readFileSync(filename, "utf8");
  assert.match(source, /core-staging\.aisr\.online/u);
  assert.match(source, /auth-staging\.aisr\.online/u);
  assert.doesNotMatch(source, /https:\/\/core\.aisr\.online/u);
  assert.doesNotMatch(source, /https:\/\/auth\.aisr\.online/u);
  assert.match(source, /lsp_agt_/u, "Golden Flow must prove opaque Agent API credential execution");
  assert.match(source, /authorization-requests/u, "Golden Flow must prove Authorization Request lifecycle");
  assert.match(source, /Pending Authorization Request unexpectedly granted Authority/u, "request creation must be proven non-authorizing");
  assert.match(source, /confirmation/u, "Golden Flow must bind confirmation to the canonical projection");
  assert.match(source, /\/people/u, "Golden Flow must prove first-class Person Directory execution");
  assert.match(source, /person_group/u, "Golden Flow must prove ordinary Person Group relation semantics");
  assert.match(source, /\/models\/bulk/u, "Golden Flow must prove non-atomic Bulk execution");
  assert.match(source, /\["succeeded", "succeeded", "succeeded", "failed"\]/u, "Bulk smoke must require partial success with mixed CRUD");
  assert.match(source, /15 \* 60 \* 1000/u, "temporary Agent credential must remain bounded to 15 minutes");
  assert.match(source, /finally \{/u, "temporary runtime authority must be cleaned even on verifier failure");
});

test("canonical staging deployment executes platform Golden Flow before authority cleanup", () => {
  const source = readFileSync(fileURLToPath(workflow), "utf8");
  const syntaxCheckIndex = source.indexOf("node --check infra/scripts/verify-staging-platform-golden-flow.mjs");
  const verifyIndex = source.indexOf("- name: Verify LifeSpace platform Golden Flow");
  const cleanupIndex = source.indexOf("- name: Cleanup ephemeral staging authority");

  assert.notEqual(syntaxCheckIndex, -1, "staging deploy must syntax-check the platform Golden Flow verifier");
  assert.notEqual(verifyIndex, -1, "staging deploy must execute the platform Golden Flow verifier");
  assert.notEqual(cleanupIndex, -1, "staging deploy must retain ephemeral authority cleanup");
  assert.ok(verifyIndex < cleanupIndex, "platform Golden Flow must complete before ephemeral authority cleanup");
});

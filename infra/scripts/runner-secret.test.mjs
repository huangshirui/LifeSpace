import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("./runner-secret.mjs", import.meta.url).href;
function run(actions) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { registerRunnerSecret } from ${JSON.stringify(moduleUrl)}; registerRunnerSecret("synthetic%value\\r\\nsecond");`], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: actions } });
}

test("local invocations never print a secret or a runner command", () => {
  const result = run("false");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("Actions delegates escaping and masking to the official toolkit", () => {
  const result = run("true");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "::add-mask::synthetic%25value%0D%0Asecond");
  assert.equal(result.stderr, "");
});

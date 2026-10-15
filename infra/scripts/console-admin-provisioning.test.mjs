import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./prepare-staging-console-admin.mjs", import.meta.url), "utf8");

test("Console Core executor verifier preserves bounded Platform Admin scopes", () => {
  const scopeStart = source.indexOf("const CORE_EXECUTOR_SCOPES = [");
  const scopeEnd = source.indexOf("];", scopeStart) + 2;
  const scopeBlock = source.slice(scopeStart, scopeEnd);
  for (const scope of ["models:manage", "applications:manage", "spaces:inspect", "spaces:manage", "grants:manage", "audit:read"]) {
    assert.match(scopeBlock, new RegExp(`"${scope}"`, "u"));
  }
  assert.doesNotMatch(scopeBlock, /profile:read/u);

  const fnStart = source.indexOf("async function verifyCoreBearer");
  const fnEnd = source.indexOf("\n}\n\nconst convergence", fnStart) + 2;
  const fn = source.slice(fnStart, fnEnd);
  assert.match(fn, /\/api\/v1\/model-admin\/models/u);
  assert.doesNotMatch(fn, /\/api\/v1\/me/u);
  assert.match(fn, /sameStringSet\(tokenScopes, CORE_EXECUTOR_SCOPES\)/u);
});

test("Console Platform Admin Space governance scopes converge in staging and production provisioning", () => {
  for (const name of ["prepare-staging-console-admin.mjs", "prepare-production-console-admin.mjs"]) {
    const text = fs.readFileSync(new URL(name, import.meta.url), "utf8");
    const appStart = text.indexOf("const APPLICATION_SCOPES = [");
    const appBlock = text.slice(appStart, text.indexOf("];", appStart));
    assert.match(appBlock, /"spaces:manage"/u);
    assert.match(appBlock, /"grants:manage"/u);
    const executorStart = text.indexOf("const CORE_EXECUTOR_SCOPES = [");
    const executorBlock = text.slice(executorStart, text.indexOf("];", executorStart));
    assert.match(executorBlock, /"spaces:manage"/u);
    assert.match(executorBlock, /"grants:manage"/u);
    assert.match(executorBlock, /"spaces:inspect"/u);
  }
});

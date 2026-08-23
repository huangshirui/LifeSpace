import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./prepare-staging-console-admin.mjs", import.meta.url), "utf8");

test("Console Core executor verifier preserves least privilege", () => {
  const scopeStart = source.indexOf("const CORE_EXECUTOR_SCOPES = [");
  const scopeEnd = source.indexOf("];", scopeStart) + 2;
  const scopeBlock = source.slice(scopeStart, scopeEnd);
  assert.match(scopeBlock, /"models:manage"/u);
  assert.doesNotMatch(scopeBlock, /profile:read/u);

  const fnStart = source.indexOf("async function verifyCoreBearer");
  const fnEnd = source.indexOf("\n}\n\nconst convergence", fnStart) + 2;
  const fn = source.slice(fnStart, fnEnd);
  assert.match(fn, /\/api\/v1\/model-admin\/models/u);
  assert.doesNotMatch(fn, /\/api\/v1\/me/u);
  assert.match(fn, /sameStringSet\(tokenScopes, CORE_EXECUTOR_SCOPES\)/u);
});

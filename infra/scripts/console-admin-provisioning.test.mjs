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

test("Console staging provisioning seeds administrators only on creation or explicit recovery", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/lifespace-console-staging-provision.yml", import.meta.url), "utf8");
  assert.match(workflow, /recover_platform_admin:\s*\n\s*description: Explicitly reassign/u);
  assert.match(workflow, /default: false\s*\n\s*type: boolean/u);
  assert.match(workflow, /LIFESPACE_STAGING_CONSOLE_RECOVER_PLATFORM_ADMIN:.*inputs\.recover_platform_admin/u);
  assert.match(source, /const recoverPlatformAdmin = process\.env\.LIFESPACE_STAGING_CONSOLE_RECOVER_PLATFORM_ADMIN === "1"/u);
  assert.match(source, /const administratorState = applicationCreated \|\| recoverPlatformAdmin\s*\? await ensurePlatformAdministrator\(\)\s*: \{ status: "unchanged-unverified" \}/u);
  assert.match(source, /assignmentRequested: applicationCreated \|\| recoverPlatformAdmin/u);
  assert.equal((source.match(/await ensurePlatformAdministrator\(\)/gu) ?? []).length, 1, "No other implicit Bootstrap admin assignment");
});

test("Console staging credential rotation does not first enumerate Bootstrap credentials", () => {
  const start = source.indexOf("async function ensureApplicationCredential(");
  const end = source.indexOf("\n}\n", start) + 2;
  assert.ok(start > 0 && end > start, "Credential policy exists");
  const body = source.slice(start, end);
  assert.match(body, /if \(applicationCreated\) return/u);
  assert.match(body, /if \(rotateCredentials\) return createReplacementApplicationCredential\("rotation"\)/u);
  assert.match(body, /if \(suppliedApplicationCredential\) return/u);
  assert.doesNotMatch(body, /\/bootstrap\/v1\//u);
  assert.doesNotMatch(body, /listCredentials|active\.length|recovery-no-active-credential/u);
  assert.match(body, /explicitly set LIFESPACE_STAGING_CONSOLE_ROTATE_CREDENTIALS=1/u);
});

test("Session-only Console setup never mutates existing Application policy via Bootstrap", () => {
  const shell = fs.readFileSync(new URL("./prepare-staging-console-shell.mjs", import.meta.url), "utf8");
  assert.match(shell, /function requireExistingApplicationPolicy\(existing\)/u);
  assert.match(shell, /if \(existing\.status !== "active"\) mismatches\.push\("status"\)/u);
  assert.match(shell, /if \(!sameStringSet\(existing\.allowedScopes, APPLICATION_SCOPES\)\)/u);
  assert.match(shell, /if \(existing\.accessTokenTtlSeconds !== TOKEN_TTL_SECONDS\)/u);
  assert.match(shell, /session-only provisioning will not change it/u);
  assert.doesNotMatch(shell, /method: "PATCH"|reconcileApplication/u);
  assert.ok(shell.indexOf("requireExistingApplicationPolicy(lookup.payload.data)") < shell.indexOf("credential = await rotateApplicationCredential()"),
    "Reject disabled or drifted Applications before rotating an lsa_* credential");
  assert.match(shell, /if \(lookup\.response\.status === 404\)/u, "Keep first trusted-Application seed");
  assert.match(shell, /const audience = await ensureAudience\(\)/u, "Keep first-use Access audience registration");
  assert.match(shell, /existingPolicyUnchanged: !created/u);
});

test("Production Console deployment verifies existing administrator rather than reassigning it", () => {
  const prod = fs.readFileSync(new URL("./prepare-production-console-admin.mjs", import.meta.url), "utf8");
  const resolver = fs.readFileSync(new URL("./resolve-production-console-admin.mjs", import.meta.url), "utf8");
  const workflow = fs.readFileSync(new URL("../../.github/workflows/lifespace-console-production-deploy.yml", import.meta.url), "utf8");
  assert.match(prod, /async function resolvePlatformAdminUserId\(\)/u);
  assert.match(prod, /\/bootstrap\/v1\/platform-administrators/u);
  assert.match(prod, /active\.some\(\(entry\) => entry\.userId === suppliedAdminUserId\)/u);
  assert.doesNotMatch(prod, /ensurePlatformAdministrator|method: "PUT",\s*bootstrap: true/u);
  assert.match(prod, /assignmentRequested: false/u);

  assert.match(resolver, /const recoverPlatformAdmin = process\.env\.LIFESPACE_PRODUCTION_CONSOLE_RECOVER_PLATFORM_ADMIN === "1"/u);
  assert.match(resolver, /if \(!isActive && !recoverPlatformAdmin\)/u);
  assert.match(resolver, /if \(!recoverPlatformAdmin\)/u);
  assert.match(resolver, /unique-verified-access-principal/u);
  assert.match(workflow, /LIFESPACE_PRODUCTION_CONSOLE_RECOVER_PLATFORM_ADMIN:.*inputs\.recover_platform_admin/u);
  assert.match(workflow, /LIFESPACE_PRODUCTION_CONSOLE_RECOVER_CONFIGURATION:.*inputs\.recover_console_configuration/u);
});

test("Production Console existing Application/Audience policy changes require explicit recovery", () => {
  const prod = fs.readFileSync(new URL("./prepare-production-console-admin.mjs", import.meta.url), "utf8");
  const workflow = fs.readFileSync(new URL("../../.github/workflows/lifespace-console-production-deploy.yml", import.meta.url), "utf8");
  assert.match(prod, /const recoverConfiguration = process\.env\.LIFESPACE_PRODUCTION_CONSOLE_RECOVER_CONFIGURATION === "1"/u);
  assert.match(prod, /if \(!created && !recoverConfiguration\)/u);
  assert.match(prod, /if \(!applicationCreated && !recoverConfiguration\)/u);
  assert.match(prod, /explicit recover_console_configuration is required/u);
  assert.match(prod, /await ensureAudience\(access\.audience, application\.created\)/u);
  assert.match(prod, /await rotateApplicationCredential\(application\.created, application\.initialSecret\)/u);
  assert.match(prod, /await rotateCoreToken\(applicationCredential\.secret, principal\.id, adminUserId\)/u);
  for (const input of ["recover_platform_admin", "recover_console_configuration"]) {
    const lines = workflow.split("\n");
    const at = lines.indexOf(`      ${input}:`);
    assert.ok(at >= 0);
    const block = lines.slice(at + 1, at + 6).join("\n");
    assert.match(block, /default: false/u);
    assert.match(block, /type: boolean/u);
  }
});

test("Production Console ordinary release does not call Bootstrap or rotate installed executor secrets", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/lifespace-console-production-deploy.yml", import.meta.url), "utf8");
  const access = fs.readFileSync(new URL("./prepare-production-console-access.mjs", import.meta.url), "utf8");
  const lines = workflow.split("\n");
  const at = lines.indexOf("      rotate_executor_credentials:");
  assert.ok(at > 0);
  assert.match(lines.slice(at + 1, at + 6).join("\n"), /default: false/u);
  assert.match(workflow, /if: \$\{\{ !inputs\.rotate_executor_credentials \}\}/u);
  assert.match(workflow, /wrangler secret list --env production --format json/u);
  assert.match(workflow, /IDENTITY_APPLICATION_CREDENTIAL/u);
  assert.match(workflow, /CORE_EXECUTOR_BEARER/u);
  assert.match(workflow, /pnpm exec wrangler deploy --env production\n/u);
  assert.match(workflow, /pnpm exec wrangler deploy --env production --secrets-file/u);
  const jobEnv = workflow.slice(workflow.indexOf("    env:"), workflow.indexOf("    steps:"));
  assert.doesNotMatch(jobEnv, /LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET/u);
  for (const name of [
    "Resolve production Console platform administrator",
    "Prepare production Console application and executors",
    "Revoke superseded Console executor credentials",
  ]) {
    const start = workflow.indexOf(`      - name: ${name}\n`);
    const body = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));
    assert.ok(start > 0);
    assert.match(body, /if: \$\{\{ inputs\.rotate_executor_credentials \}\}/u);
    assert.match(body, /LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET/u);
  }
  assert.match(access, /LIFESPACE_PRODUCTION_CONSOLE_ALLOW_ACCESS_CREATE !== "1"/u);
  assert.match(workflow, /inputs\.rotate_executor_credentials && inputs\.recover_console_configuration/u);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
}

const profile = readJson("infra/homemew-integration-profile.json");
const corePackage = readJson("apps/core/package.json");
const identityPackage = readJson("apps/identity/package.json");

assert.equal(profile.profileVersion, 1, "HomeMew integration profile version must remain explicit");
assert.ok(["phase4-candidate", "accepted"].includes(profile.status), "HomeMew integration profile status is invalid");
assert.equal(profile.application?.key, "homemew");
assert.equal(profile.application?.clientType, "mini_program");
assert.equal(profile.application?.trustedBackend, true);
assert.equal(profile.application?.accessTokenTtlSeconds, 900);
assert.equal(profile.trustedBackend?.credentialType, "lsa_application_credential");
assert.equal(profile.trustedBackend?.credentialLocation, "server_only");
assert.equal(profile.trustedBackend?.miniProgramMayAssertLifeSpaceUserId, false);

const allowedScopes = profile.application?.allowedUserScopes ?? [];
const forbiddenScopes = profile.application?.forbiddenUserScopes ?? [];
assert.ok(Array.isArray(allowedScopes) && allowedScopes.length > 0, "HomeMew allowed user scopes must be explicit");
assert.equal(new Set(allowedScopes).size, allowedScopes.length, "HomeMew allowed user scopes must be unique");
assert.ok(!allowedScopes.includes("models:manage"), "HomeMew user scope ceiling must exclude models:manage");
assert.ok(forbiddenScopes.includes("models:manage"), "HomeMew profile must explicitly forbid models:manage");

const expectedModels = ["day_record", "event", "task", "wish"];
assert.deepEqual(Object.keys(profile.modelAccess ?? {}).sort(), expectedModels);
for (const modelKey of expectedModels) {
  assert.equal(profile.modelAccess[modelKey], "write", `HomeMew ${modelKey} access must be write`);
}

assert.equal(profile.contracts?.coreKernel, corePackage.version, "HomeMew Core pin must match repository Core version");
assert.equal(profile.contracts?.identity, identityPackage.version, "HomeMew Identity pin must match repository Identity version");
assert.match(profile.contracts?.modelContract ?? "", /^mct_[a-f0-9]{64}$/u, "HomeMew Model Contract pin must be content-addressed");
assert.ok(["proving-not-frozen", "accepted"].includes(profile.contracts?.pinStatus), "HomeMew contract pin status is invalid");

const serialized = JSON.stringify(profile);
for (const pattern of [/lsa_[A-Za-z0-9_-]{20,}/u, /lsp_pat_[A-Za-z0-9_-]{8,}/u, /"clientSecret"/u, /"secretHash"/u, /"privateKey"/u]) {
  assert.doesNotMatch(serialized, pattern, `HomeMew handoff profile must not contain secret material matching ${pattern}`);
}

console.log(JSON.stringify({
  ok: true,
  application: profile.application.key,
  coreKernel: profile.contracts.coreKernel,
  identity: profile.contracts.identity,
  modelContract: profile.contracts.modelContract,
  tokenTtlSeconds: profile.application.accessTokenTtlSeconds,
  modelAccess: profile.modelAccess,
  platformAdminScopeExcluded: true,
}, null, 2));

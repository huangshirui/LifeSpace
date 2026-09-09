import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { acceptedHomeMewModelSemantics } from "../../../infra/scripts/homemew-contract-identity.mjs";

const ROOT = new URL("../../../", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
}

const profile = readJson("infra/homemew-integration-profile.json");
const corePackage = readJson("apps/core/package.json");
const identityPackage = readJson("apps/identity/package.json");

assert.equal(profile.profileVersion, 3, "HomeMew integration profile version must remain explicit");
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

assert.match(profile.contracts?.coreKernel ?? "", /^\d+\.\d+\.\d+$/u, "HomeMew Core pin must be an explicit semantic version");
assert.match(profile.contracts?.identity ?? "", /^\d+\.\d+\.\d+$/u, "HomeMew Identity pin must be an explicit semantic version");
assert.match(profile.contracts?.integrationEventing ?? "", /^\d+\.\d+\.\d+$/u, "post-split HomeMew releases must explicitly pin Integration/Eventing");
assert.notEqual(profile.contracts?.coreKernel, "", "HomeMew Core pin must remain explicit");
assert.notEqual(profile.contracts?.identity, "", "HomeMew Identity pin must remain explicit");
// Accepted application pins are compatibility evidence and do not silently follow later platform package versions.
void corePackage;
void identityPackage;
const modelSemantics = acceptedHomeMewModelSemantics(profile);
assert.deepEqual(modelSemantics.models.map((model) => model.key), expectedModels);
for (const model of modelSemantics.models) {
  assert.equal("route" in model, false, `HomeMew v3 model ${model.key} must use modelKey + schemaHash identity only`);
}
assert.ok(["proving-not-frozen", "accepted"].includes(profile.contracts?.pinStatus), "HomeMew contract pin status is invalid");
assert.match(profile.evidence?.acceptedStagingModelContract ?? "", /^mct_[a-f0-9]{64}$/u, "HomeMew accepted staging Model Contract evidence must remain immutable and content-addressed");
assert.equal("modelContract" in (profile.contracts ?? {}), false, "Environment-local mct_* must not be represented as the cross-environment HomeMew contract identity");

const serialized = JSON.stringify(profile);
for (const pattern of [/lsa_[a-f0-9]{64}/u, /lsp_pat_[A-Za-z0-9_-]{8,}/u, /"clientSecret"/u, /"secretHash"/u, /"privateKey"/u]) {
  assert.doesNotMatch(serialized, pattern, `HomeMew handoff profile must not contain secret material matching ${pattern}`);
}

console.log(JSON.stringify({
  ok: true,
  application: profile.application.key,
  coreKernel: profile.contracts.coreKernel,
  identity: profile.contracts.identity,
  integrationEventing: profile.contracts.integrationEventing,
  modelSemanticFingerprint: modelSemantics.fingerprint,
  acceptedStagingModelContractEvidence: profile.evidence.acceptedStagingModelContract,
  tokenTtlSeconds: profile.application.accessTokenTtlSeconds,
  modelAccess: profile.modelAccess,
  platformAdminScopeExcluded: true,
}, null, 2));

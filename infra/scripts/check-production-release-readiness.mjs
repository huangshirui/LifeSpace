import { readFileSync } from "node:fs";
import { acceptedHomeMewModelSemantics, assertHomeMewModelSemanticCompatibility } from "./homemew-contract-identity.mjs";
import { PRODUCTION_EXPECTATIONS, PRODUCTION_PROVING_MODELS } from "./production-expectations.mjs";

const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));

function fail(message) {
  throw new Error(message);
}

if (profile.contracts?.coreKernel !== PRODUCTION_EXPECTATIONS.core.contractVersion) {
  fail(`Production release is not promoted for HomeMew: accepted Core ${profile.contracts?.coreKernel}, repository production Core ${PRODUCTION_EXPECTATIONS.core.contractVersion}`);
}
if (profile.contracts?.identity !== PRODUCTION_EXPECTATIONS.identity.contractVersion) {
  fail(`Production release is not promoted for HomeMew: accepted Identity ${profile.contracts?.identity}, repository production Identity ${PRODUCTION_EXPECTATIONS.identity.contractVersion}`);
}

const provingManifest = PRODUCTION_PROVING_MODELS.map((model) => ({
  key: model.key,
  route: model.route,
  schemaHash: model.hash,
}));
const semantic = assertHomeMewModelSemanticCompatibility(
  profile,
  provingManifest,
  "Repository production proving semantics",
);
const accepted = acceptedHomeMewModelSemantics(profile);

console.log(JSON.stringify({
  ok: true,
  coreKernel: profile.contracts.coreKernel,
  identity: profile.contracts.identity,
  modelSemanticFingerprint: semantic.fingerprint,
  acceptedModelCount: accepted.models.length,
  productionMutationAllowed: true,
}, null, 2));

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);

function text(path) {
  return readFileSync(new URL(path, ROOT), "utf8");
}

const workflow = text(".github/workflows/staging-deploy.yml");
const candidateExporter = text("packages/contracts/scripts/export-homemew-staging-candidate.mjs");
const acceptedExporter = text("packages/contracts/scripts/export-homemew-handoff.mjs");

assert.match(candidateExporter, /model-admin\/contracts\/active/u, "candidate export must use the active staging Model Contract");
assert.match(candidateExporter, /coreData\?\.contractVersion !== corePackage\.version/u, "candidate export must bind to the repository current Core contract");
assert.match(candidateExporter, /identityData\?\.contractVersion !== identityPackage\.version/u, "candidate export must bind to the repository current Identity contract");
assert.match(candidateExporter, /calculateModelSemanticFingerprint/u, "candidate export must calculate current model semantic identity");
assert.match(candidateExporter, /promotionRequired/u, "candidate export must state whether explicit downstream promotion is still required");
assert.match(candidateExporter, /acceptedBaseline/u, "candidate evidence must preserve the accepted baseline as comparison metadata");

assert.match(acceptedExporter, /HomeMew accepted handoff remains pinned/u, "accepted exporter must remain fail-closed on current/accepted contract drift");
assert.match(acceptedExporter, /profile\.contracts\?\.coreKernel !== corePackage\.version/u, "accepted exporter must still reject newer Core source contracts under an older pin");

assert.match(workflow, /export:homemew:candidate/u, "staging deploy must export current candidate evidence");
assert.match(workflow, /packages\/contracts\/dist\/homemew-candidate/u, "staging deploy must upload the candidate directory");
assert.doesNotMatch(workflow, /pnpm --filter @lifespace\/contracts export:homemew\n/u, "staging deploy must not export the accepted HomeMew handoff while the pin can lag platform staging");
assert.match(workflow, /HomeMew staging candidate semantic contract bundle/u, "staging summary must describe candidate evidence rather than accepted evidence");

console.log(JSON.stringify({
  ok: true,
  acceptedExporterStillFailClosed: true,
  stagingCandidateSeparatedFromAcceptedPin: true,
  explicitPromotionStillRequired: true,
}, null, 2));

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { assertHomeMewModelSemanticCompatibility } from "./homemew-contract-identity.mjs";
import { PRODUCTION_EXPECTATIONS } from "./production-expectations.mjs";

await import("./resolve-production-d1.mjs");

const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const profile = JSON.parse(readFileSync(new URL("../homemew-integration-profile.json", import.meta.url), "utf8"));

function fail(message, detail) {
  if (detail !== undefined) console.error(detail);
  throw new Error(message);
}

function runCoreSql(sql) {
  const stdout = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "production", "--json", `--command=${sql}`],
    { cwd: CORE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: process.env },
  );
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  for (const entry of entries) {
    if (entry?.success === false) fail("Production Core D1 query failed", entry);
    if (Array.isArray(entry?.results)) return entry.results;
    if (Array.isArray(entry?.result?.results)) return entry.result.results;
  }
  return [];
}

if (profile.contracts?.coreKernel !== PRODUCTION_EXPECTATIONS.core.contractVersion) {
  fail(`HomeMew Core release pin ${profile.contracts?.coreKernel} does not match production release ${PRODUCTION_EXPECTATIONS.core.contractVersion}`);
}
if (profile.contracts?.identity !== PRODUCTION_EXPECTATIONS.identity.contractVersion) {
  fail(`HomeMew Identity release pin ${profile.contracts?.identity} does not match production release ${PRODUCTION_EXPECTATIONS.identity.contractVersion}`);
}

const rows = runCoreSql(`SELECT s.active_contract_id,s.registry_revision,r.contract_hash,r.manifest_json
  FROM model_contract_state s JOIN model_contract_revisions r ON r.id=s.active_contract_id
  WHERE s.singleton=1`);
if (rows.length !== 1) fail("Expected exactly one active production Model Contract", rows);
const active = rows[0];
if (!/^mct_[a-f0-9]{64}$/u.test(active.active_contract_id ?? "")) fail("Production active Model Contract id is invalid", active);
if (active.contract_hash !== active.active_contract_id.slice(4)) fail("Production active Model Contract id/hash mismatch", active);
if (Number(active.registry_revision) < 1) fail("Production active Model Contract registry revision is invalid", active);

let manifest;
try {
  manifest = JSON.parse(active.manifest_json);
} catch {
  fail("Production active Model Contract manifest_json is invalid JSON");
}
if (manifest?.kind !== "lifespace-model-contract" || !Array.isArray(manifest?.models)) {
  fail("Production active Model Contract manifest is invalid", manifest);
}

const semantic = assertHomeMewModelSemanticCompatibility(profile, manifest.models, "Production active Model Contract");
const versions = Object.fromEntries(
  semantic.models.map((model) => [model.key, manifest.models.find((entry) => entry.key === model.key)?.version]),
);

console.log(JSON.stringify({
  ok: true,
  coreKernel: profile.contracts.coreKernel,
  identity: profile.contracts.identity,
  modelSemanticFingerprint: semantic.fingerprint,
  activeModelContract: active.active_contract_id,
  registryRevision: Number(active.registry_revision),
  environmentLocalModelVersions: versions,
  crossEnvironmentMctEqualityRequired: false,
}, null, 2));

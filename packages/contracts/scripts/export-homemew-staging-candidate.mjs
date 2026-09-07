import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";
import {
  acceptedHomeMewModelSemantics,
  calculateModelSemanticFingerprint,
} from "../../../infra/scripts/homemew-contract-identity.mjs";

const ROOT = new URL("../../../", import.meta.url);
const OUTPUT_DIR = new URL("../dist/homemew-candidate/", import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function fetchJson(url, { bearer } = {}) {
  const response = await fetch(url, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

const profile = readJson("infra/homemew-integration-profile.json");
const corePackage = readJson("apps/core/package.json");
const identityPackage = readJson("apps/identity/package.json");
const integrationEventingContract = readJson("apps/core/integration-eventing.openapi.yaml");
const integrationEventingVersion = integrationEventingContract.info?.version;
if (!/^\d+\.\d+\.\d+$/u.test(integrationEventingVersion ?? "")) throw new Error("Integration/Eventing contract version is invalid");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const expectedEnvironment = process.env.LIFESPACE_HANDOFF_ENVIRONMENT ?? "staging";
const modelAdminBearer = process.env.LIFESPACE_MODEL_ADMIN_BEARER ?? process.env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER ?? "";

if (!modelAdminBearer) throw new Error("LIFESPACE_MODEL_ADMIN_BEARER or LIFESPACE_STAGING_MODEL_ADMIN_BEARER is required");
if (expectedEnvironment !== "staging") throw new Error("HomeMew candidate handoff exporter is staging-only");

const [coreStatus, identityStatus] = await Promise.all([
  fetchJson(`${coreBase}/api/v1/status`),
  fetchJson(`${identityBase}/api/v1/status`),
]);
const coreData = coreStatus.payload?.data;
const identityData = identityStatus.payload?.data;
if (
  coreStatus.response.status !== 200
  || coreData?.environment !== expectedEnvironment
  || coreData?.contractVersion !== corePackage.version
) {
  throw new Error(`Core staging does not match repository current contract ${corePackage.version}: ${coreStatus.response.status} ${JSON.stringify(coreStatus.payload)}`);
}
if (
  identityStatus.response.status !== 200
  || identityData?.environment !== expectedEnvironment
  || identityData?.contractVersion !== identityPackage.version
) {
  throw new Error(`Identity staging does not match repository current contract ${identityPackage.version}: ${identityStatus.response.status} ${JSON.stringify(identityStatus.payload)}`);
}

const contractResult = await fetchJson(
  `${coreBase}/api/v1/model-admin/contracts/active`,
  { bearer: modelAdminBearer },
);
const modelContract = contractResult.payload?.data;
if (contractResult.response.status !== 200 || !/^mct_[a-f0-9]{64}$/u.test(modelContract?.id ?? "")) {
  throw new Error(`Active staging Model Contract could not be loaded: ${contractResult.response.status} ${JSON.stringify(contractResult.payload)}`);
}
if (modelContract.hash !== modelContract.id.slice(4)) {
  throw new Error("Active staging Model Contract evidence id/hash mismatch");
}
if (modelContract.manifest?.kind !== "lifespace-model-contract" || !Array.isArray(modelContract.manifest?.models)) {
  throw new Error("Active staging Model Contract manifest is invalid");
}

const acceptedModelSemantics = acceptedHomeMewModelSemantics(profile);
const manifestByKey = new Map(modelContract.manifest.models.map((model) => [model?.key, model]));
const candidateModels = acceptedModelSemantics.models.map(({ key }) => {
  const model = manifestByKey.get(key);
  if (!model) throw new Error(`Active staging Model Contract is missing HomeMew model ${key}`);
  return {
    key,
    route: model.route,
    schemaHash: model.schemaHash,
  };
});
const candidateFingerprint = calculateModelSemanticFingerprint(candidateModels);
const matchesAcceptedTuple = (
  corePackage.version === profile.contracts?.coreKernel
  && identityPackage.version === profile.contracts?.identity
  && integrationEventingVersion === profile.contracts?.integrationEventing
  && candidateFingerprint === acceptedModelSemantics.fingerprint
);

const files = new Map([
  ["core-kernel.openapi.yaml", readFileSync(new URL("apps/core/openapi.yaml", ROOT), "utf8")],
  ["integration-eventing.openapi.yaml", readFileSync(new URL("apps/core/integration-eventing.openapi.yaml", ROOT), "utf8")],
  ["identity.openapi.yaml", readFileSync(new URL("apps/identity/openapi.yaml", ROOT), "utf8")],
  ["model-contract.openapi.json", json(modelContract.openapi)],
  ["model-contract.schema.json", json(modelContract.jsonSchema)],
  ["model-contract.manifest.json", json(modelContract.manifest)],
  ["accepted-homemew-integration-profile.json", json(profile)],
]);

const candidate = {
  kind: "lifespace-application-contract-candidate",
  formatVersion: 1,
  application: "homemew",
  status: "staging-candidate",
  contracts: {
    identity: identityPackage.version,
    coreKernel: corePackage.version,
    integrationEventing: integrationEventingVersion,
    modelSemanticFingerprint: candidateFingerprint,
  },
  evidence: {
    environment: expectedEnvironment,
    modelContract: modelContract.id,
  },
  modelSemantics: candidateModels,
  modelManifest: modelContract.manifest.models,
  acceptedBaseline: {
    status: profile.status,
    pinStatus: profile.contracts?.pinStatus,
    identity: profile.contracts?.identity,
    coreKernel: profile.contracts?.coreKernel,
    integrationEventing: profile.contracts?.integrationEventing ?? null,
    modelSemanticFingerprint: acceptedModelSemantics.fingerprint,
    modelContractEvidence: profile.evidence?.acceptedStagingModelContract,
  },
  matchesAcceptedTuple,
  promotionRequired: !matchesAcceptedTuple,
};
files.set("candidate.json", json(candidate));

const fileHashes = Object.fromEntries(
  [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, sha256(content)]),
);
const bundleId = `hmc_${sha256(canonicalJson(fileHashes))}`;
const checksums = {
  kind: "lifespace-contract-candidate-checksums",
  bundleId,
  algorithm: "sha256",
  files: fileHashes,
};
files.set("checksums.json", json(checksums));

rmSync(OUTPUT_DIR, { recursive: true, force: true });
mkdirSync(OUTPUT_DIR, { recursive: true });
for (const [name, content] of files) writeFileSync(new URL(name, OUTPUT_DIR), content, "utf8");

console.log(JSON.stringify({
  ok: true,
  bundleId,
  output: "packages/contracts/dist/homemew-candidate",
  contracts: candidate.contracts,
  evidence: candidate.evidence,
  acceptedBaseline: candidate.acceptedBaseline,
  matchesAcceptedTuple,
  promotionRequired: candidate.promotionRequired,
  validatedDeployment: {
    environment: expectedEnvironment,
    coreSchemaVersion: coreData.schemaVersion,
    identitySchemaVersion: identityData.schemaVersion,
  },
  files: [...files.keys()].sort(),
  secretMaterialIncluded: false,
}, null, 2));

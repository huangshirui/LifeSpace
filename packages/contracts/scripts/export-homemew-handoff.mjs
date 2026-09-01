import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import process from "node:process";

const ROOT = new URL("../../../", import.meta.url);
const OUTPUT_DIR = new URL("../dist/homemew/", import.meta.url);

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
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const expectedEnvironment = process.env.LIFESPACE_HANDOFF_ENVIRONMENT ?? "staging";
const modelAdminBearer = process.env.LIFESPACE_MODEL_ADMIN_BEARER ?? process.env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER ?? "";

if (!modelAdminBearer) throw new Error("LIFESPACE_MODEL_ADMIN_BEARER or LIFESPACE_STAGING_MODEL_ADMIN_BEARER is required");
if (profile.contracts?.coreKernel !== corePackage.version || profile.contracts?.identity !== identityPackage.version) {
  throw new Error(`HomeMew accepted handoff remains pinned to Core ${profile.contracts?.coreKernel} / Identity ${profile.contracts?.identity}, while repository current contracts are Core ${corePackage.version} / Identity ${identityPackage.version}. Do not export newer source OpenAPI under the older accepted tuple; complete an explicit downstream compatibility/staging decision and repin first.`);
}
if (!/^mct_[a-f0-9]{64}$/u.test(profile.contracts?.modelContract ?? "")) throw new Error("HomeMew Model Contract pin is invalid");

const [coreStatus, identityStatus] = await Promise.all([
  fetchJson(`${coreBase}/api/v1/status`),
  fetchJson(`${identityBase}/api/v1/status`),
]);
const coreData = coreStatus.payload?.data;
const identityData = identityStatus.payload?.data;
if (
  coreStatus.response.status !== 200
  || coreData?.environment !== expectedEnvironment
  || coreData?.contractVersion !== profile.contracts.coreKernel
) {
  throw new Error(`Core deployment does not match HomeMew handoff pin: ${coreStatus.response.status} ${JSON.stringify(coreStatus.payload)}`);
}
if (
  identityStatus.response.status !== 200
  || identityData?.environment !== expectedEnvironment
  || identityData?.contractVersion !== profile.contracts.identity
) {
  throw new Error(`Identity deployment does not match HomeMew handoff pin: ${identityStatus.response.status} ${JSON.stringify(identityStatus.payload)}`);
}

const contractResult = await fetchJson(
  `${coreBase}/api/v1/model-admin/contracts/${encodeURIComponent(profile.contracts.modelContract)}`,
  { bearer: modelAdminBearer },
);
const modelContract = contractResult.payload?.data;
if (contractResult.response.status !== 200 || modelContract?.id !== profile.contracts.modelContract) {
  throw new Error(`Pinned HomeMew Model Contract could not be loaded: ${contractResult.response.status} ${JSON.stringify(contractResult.payload)}`);
}
if (modelContract.hash !== profile.contracts.modelContract.slice(4)) {
  throw new Error("Pinned Model Contract id/hash mismatch");
}
if (modelContract.manifest?.kind !== "lifespace-model-contract" || !Array.isArray(modelContract.manifest?.models)) {
  throw new Error("Pinned Model Contract manifest is invalid");
}
for (const modelKey of Object.keys(profile.modelAccess ?? {})) {
  if (!modelContract.manifest.models.some((model) => model.key === modelKey)) {
    throw new Error(`Pinned Model Contract is missing HomeMew model ${modelKey}`);
  }
}

const files = new Map([
  ["core-kernel.openapi.yaml", readFileSync(new URL("apps/core/openapi.yaml", ROOT), "utf8")],
  ["identity.openapi.yaml", readFileSync(new URL("apps/identity/openapi.yaml", ROOT), "utf8")],
  ["model-contract.openapi.json", json(modelContract.openapi)],
  ["model-contract.schema.json", json(modelContract.jsonSchema)],
  ["model-contract.manifest.json", json(modelContract.manifest)],
  ["homemew-integration-profile.json", json(profile)],
]);

const handoff = {
  kind: "lifespace-application-contract-handoff",
  formatVersion: 1,
  application: "homemew",
  status: profile.status,
  pinStatus: profile.contracts.pinStatus,
  contracts: {
    identity: profile.contracts.identity,
    coreKernel: profile.contracts.coreKernel,
    modelContract: profile.contracts.modelContract,
  },
  applicationPolicy: {
    clientType: profile.application.clientType,
    trustedBackend: profile.application.trustedBackend,
    accessTokenTtlSeconds: profile.application.accessTokenTtlSeconds,
    allowedUserScopes: profile.application.allowedUserScopes,
    forbiddenUserScopes: profile.application.forbiddenUserScopes,
    modelAccess: profile.modelAccess,
  },
  modelManifest: modelContract.manifest.models,
};
files.set("handoff.json", json(handoff));

const fileHashes = Object.fromEntries(
  [...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, content]) => [name, sha256(content)]),
);
const bundleId = `hmb_${sha256(canonicalJson(fileHashes))}`;
const checksums = {
  kind: "lifespace-contract-handoff-checksums",
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
  output: "packages/contracts/dist/homemew",
  contracts: handoff.contracts,
  validatedDeployment: {
    environment: expectedEnvironment,
    coreSchemaVersion: coreData.schemaVersion,
    identitySchemaVersion: identityData.schemaVersion,
  },
  files: [...files.keys()].sort(),
  secretMaterialIncluded: false,
}, null, 2));

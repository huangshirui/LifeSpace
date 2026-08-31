import process from "node:process";
import { PROVING_MODELS, STAGING_EXPECTATIONS, assertStagingServiceUrl } from "./staging-expectations.mjs";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const serviceBearer = process.env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER ?? "";
const userBearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";

if (!coreBaseUrl) throw new Error("LIFESPACE_CORE_STAGING_URL is required");
assertStagingServiceUrl(coreBaseUrl, "core");
if (!serviceBearer) throw new Error("LIFESPACE_STAGING_MODEL_ADMIN_BEARER is required");

const EXPECTED_MODELS = new Map(PROVING_MODELS.map((model) => [model.key, model]));

async function jsonRequest(path, { bearer, method = "GET", body } = {}) {
  const response = await fetch(`${coreBaseUrl}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`);
    }
  }
  return { response, payload };
}

function requireStatus(result, expected, label) {
  if (result.response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${result.response.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

const status = requireStatus(await jsonRequest("/api/v1/status"), 200, "Core status");
if (status?.environment !== "staging") throw new Error(`Core environment mismatch: expected staging, got ${status?.environment}`);
if (status?.contractVersion !== STAGING_EXPECTATIONS.core.contractVersion) {
  throw new Error(`Core Kernel contract mismatch: expected ${STAGING_EXPECTATIONS.core.contractVersion}, got ${status?.contractVersion}`);
}
if (Number(status?.schemaVersion) !== STAGING_EXPECTATIONS.core.schemaVersion) {
  throw new Error(`Core staging schema mismatch: expected ${STAGING_EXPECTATIONS.core.schemaVersion}, got ${status?.schemaVersion}`);
}

const models = requireStatus(await jsonRequest("/api/v1/model-admin/models", { bearer: serviceBearer }), 200, "Model Admin list");
if (!Array.isArray(models)) throw new Error("Model Admin list did not return an array");
const modelMap = new Map(models.map((model) => [model.key, model]));
const currentPublishedModels = new Map();
for (const [key, expected] of EXPECTED_MODELS) {
  const model = modelMap.get(key);
  if (!model) throw new Error(`Published proving model ${key} missing from Model Admin`);
  const actualVersion = Number(model.version);
  if (!Number.isInteger(actualVersion) || actualVersion < expected.minimumVersion) {
    throw new Error(`Published model ${key} version is below release floor: expected >= ${expected.minimumVersion}, got ${model.version}`);
  }
  if (model.route !== expected.route) throw new Error(`Published model ${key} route mismatch: expected ${expected.route}, got ${model.route}`);
  if (model.schemaHash !== expected.hash) throw new Error(`Published model ${key} schema hash mismatch: expected ${expected.hash}, got ${model.schemaHash}`);
  if (model.state !== "published") throw new Error(`Published model ${key} returned unexpected state ${model.state}`);
  currentPublishedModels.set(key, {
    version: actualVersion,
    route: model.route,
    schemaHash: model.schemaHash,
  });
}

const contract = requireStatus(await jsonRequest("/api/v1/model-admin/contracts/active", { bearer: serviceBearer }), 200, "Active Model Contract");
if (!/^mct_[a-f0-9]{64}$/u.test(contract?.id ?? "")) throw new Error(`Active Model Contract ID is invalid: ${contract?.id}`);
const manifestModels = new Map((contract?.manifest?.models ?? []).map((model) => [model.key, model]));
for (const [key, expected] of EXPECTED_MODELS) {
  const model = manifestModels.get(key);
  const published = currentPublishedModels.get(key);
  if (!model) throw new Error(`Active Model Contract manifest missing ${key}`);
  if (!published) throw new Error(`Published proving model ${key} was not captured for contract verification`);
  if (model.route !== expected.route) throw new Error(`Active Model Contract ${key} route mismatch: expected ${expected.route}, got ${model.route}`);
  if (model.schemaHash !== expected.hash) throw new Error(`Active Model Contract ${key} schema hash mismatch: expected ${expected.hash}, got ${model.schemaHash}`);
  if (Number(model.version) !== published.version) {
    throw new Error(`Active Model Contract ${key} version mismatch with current Registry: expected ${published.version}, got ${model.version}`);
  }
}

requireStatus(await jsonRequest("/api/v1/model-admin/ai/proposals", { bearer: serviceBearer }), 200, "AI Model Admin proposal list");
if (userBearer) {
  const denied = await jsonRequest("/api/v1/model-admin/ai/proposals", { bearer: userBearer });
  if (denied.response.status !== 403) throw new Error(`AI Model Admin user-principal boundary: expected HTTP 403, got ${denied.response.status}`);
}

console.log(JSON.stringify({
  ok: true,
  kernelContract: status.contractVersion,
  schemaVersion: Number(status.schemaVersion),
  activeModelContract: contract.id,
  models: Object.fromEntries([...currentPublishedModels].map(([key, model]) => [key, model.version])),
  aiModelAdminServiceBoundary: true,
  aiModelAdminUserBoundaryChecked: Boolean(userBearer),
}, null, 2));

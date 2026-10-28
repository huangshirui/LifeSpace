import process from "node:process";
import {
  BASELINE_MODEL_SEMANTICS,
  applyBaselineModelSemantics,
  baselineModelSemanticsMatch,
} from "./baseline-model-semantics.mjs";
import { PRODUCTION_PROVING_MODELS, assertProductionServiceUrl } from "./production-expectations.mjs";

const coreBase = (process.env.LIFESPACE_CORE_PRODUCTION_URL ?? "https://core.aisr.online").replace(/\/+$/u, "");
const serviceBearer = process.env.LIFESPACE_PRODUCTION_MODEL_ADMIN_BEARER ?? "";
assertProductionServiceUrl(coreBase, "core");
if (!/^lsp_svc_[0-9A-Za-z_-]{32,}$/u.test(serviceBearer)) {
  throw new Error("LIFESPACE_PRODUCTION_MODEL_ADMIN_BEARER must be a configured production lsp_svc_* service token");
}
// Reuse a pre-provisioned models:manage service principal. No Bootstrap, identity
// fixture creation, or direct production Identity D1 deletion during ordinary deploy.
console.log(`::add-mask::${serviceBearer}`);

const expectedByKey = new Map(PRODUCTION_PROVING_MODELS.map((model) => [model.key, model]));

async function jsonRequest(base, path, { method = "GET", bearer, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

let models = await jsonRequest(coreBase, "/api/v1/model-admin/models", { bearer: serviceBearer });
if (models.response.status !== 200 || !Array.isArray(models.payload?.data)) {
  throw new Error(`Production Model Admin list failed; Core↔Identity service authentication may be invalid: ${models.response.status} ${JSON.stringify(models.payload)}`);
}

const currentByKey = new Map(models.payload.data.map((model) => [model.key, model]));
const publishedSemanticModels = [];
for (const [key, semantic] of Object.entries(BASELINE_MODEL_SEMANTICS)) {
  const expected = expectedByKey.get(key);
  const current = currentByKey.get(key);
  if (!expected || !current?.definition || current.route !== semantic.route || current.definition.route !== semantic.route) {
    throw new Error(`Production model ${key} is not safe to reconcile: ${JSON.stringify(current)}`);
  }
  if (baselineModelSemanticsMatch(current.definition, semantic)) continue;

  const currentVersion = Number(current.version);
  const result = await jsonRequest(coreBase, "/api/v1/model-admin/models", {
    method: "POST",
    bearer: serviceBearer,
    body: {
      definition: applyBaselineModelSemantics(current.definition, semantic),
      compatibility: "compatible",
    },
  });
  const published = result.payload?.data;
  const publishedVersion = Number(published?.version);
  if (
    result.response.status !== 201
    || published?.key !== key
    || publishedVersion <= currentVersion
    || publishedVersion < expected.minimumVersion
    || published.schemaHash !== expected.hash
  ) {
    throw new Error(`Production semantic publication for ${key} did not converge on the accepted schema: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  publishedSemanticModels.push({
    key,
    previousVersion: current.version,
    version: published.version,
    schemaHash: published.schemaHash,
  });
}

models = await jsonRequest(coreBase, "/api/v1/model-admin/models", { bearer: serviceBearer });
if (models.response.status !== 200 || !Array.isArray(models.payload?.data)) {
  throw new Error(`Production Model Admin verification list failed: ${models.response.status} ${JSON.stringify(models.payload)}`);
}
const actualModels = new Map(models.payload.data.map((model) => [model.key, model]));
const currentPublishedModels = new Map();
for (const expected of PRODUCTION_PROVING_MODELS) {
  const actual = actualModels.get(expected.key);
  const semantic = BASELINE_MODEL_SEMANTICS[expected.key];
  const actualVersion = Number(actual?.version);
  if (
    !actual
    || actual.state !== "published"
    || actual.route !== expected.route
    || actualVersion < expected.minimumVersion
    || actual.schemaHash !== expected.hash
    || !semantic
    || !baselineModelSemanticsMatch(actual.definition, semantic)
  ) {
    throw new Error(`Production published model ${expected.key} does not match the accepted semantic baseline: ${JSON.stringify(actual)}`);
  }
  currentPublishedModels.set(expected.key, {
    route: actual.route,
    version: actualVersion,
    schemaHash: actual.schemaHash,
  });
}

const contract = await jsonRequest(coreBase, "/api/v1/model-admin/contracts/active", { bearer: serviceBearer });
const active = contract.payload?.data;
if (contract.response.status !== 200 || !/^mct_[a-f0-9]{64}$/u.test(active?.id ?? "") || active?.hash !== active.id.slice(4)) {
  throw new Error(`Production active Model Contract is invalid: ${contract.response.status} ${JSON.stringify(contract.payload)}`);
}
const contractModels = new Map((active?.manifest?.models ?? []).map((model) => [model.key, model]));
for (const expected of PRODUCTION_PROVING_MODELS) {
  const published = currentPublishedModels.get(expected.key);
  const model = contractModels.get(expected.key);
  if (
    !published
    || !model
    || model.route !== published.route
    || Number(model.version) !== published.version
    || model.schemaHash !== published.schemaHash
  ) {
    throw new Error(`Production active Model Contract does not match current published ${expected.key}: ${JSON.stringify(model)}`);
  }
}
const baselineKeys = new Set(PRODUCTION_PROVING_MODELS.map((model) => model.key));
const additionalPublishedModels = (active?.manifest?.models ?? [])
  .filter((model) => !baselineKeys.has(model.key))
  .map((model) => ({ key: model.key, route: model.route, version: model.version, schemaHash: model.schemaHash }));

console.log(JSON.stringify({
  ok: true,
  serviceAuthentication: "lsp_svc_to_core_introspection_passed",
  modelAdminServiceBoundary: true,
  publishedSemanticModels,
  activeModelContract: active.id,
  activeManifestModelCount: active.manifest.models.length,
  additionalPublishedModels,
  models: Object.fromEntries(PRODUCTION_PROVING_MODELS.map((model) => [model.key, currentPublishedModels.get(model.key)?.version])),
  identityMutationsByVerifier: false,
  serviceCredentialMode: "configured_production_service_token",
}, null, 2));

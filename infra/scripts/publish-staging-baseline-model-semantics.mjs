import process from "node:process";
import { requestWithStagingAuthConvergence } from "./staging-auth-convergence.mjs";
import {
  BASELINE_MODEL_SEMANTICS,
  applyBaselineModelSemantics,
  baselineModelSemanticsMatch,
} from "./baseline-model-semantics.mjs";

const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bearer = process.env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER ?? "";

if (coreBase !== "https://core-staging.aisr.online") {
  throw new Error(`Refusing non-staging Core URL: ${coreBase}`);
}
if (!bearer.startsWith("lsp_svc_") && !bearer.startsWith("lsp_pat_")) {
  throw new Error("LIFESPACE_STAGING_MODEL_ADMIN_BEARER is required");
}

async function jsonRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`${coreBase}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
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

async function modelAdminRequest(path, options = {}) {
  const method = options.method ?? "GET";
  return requestWithStagingAuthConvergence({
    method,
    label: `Model Admin ${method} ${path}`,
    request: () => jsonRequest(path, options),
  });
}

const listed = await modelAdminRequest("/api/v1/model-admin/models");
if (listed.response.status !== 200 || !Array.isArray(listed.payload?.data)) {
  throw new Error(`Could not list staging models: ${listed.response.status} ${JSON.stringify(listed.payload)}`);
}

const currentByKey = new Map(listed.payload.data.map((model) => [model.key, model]));
const published = [];
const unchanged = [];

for (const [key, expected] of Object.entries(BASELINE_MODEL_SEMANTICS)) {
  const current = currentByKey.get(key);
  if (!current?.definition) throw new Error(`Published staging model ${key} is missing`);
  if (current.route !== expected.route || current.definition.route !== expected.route) {
    throw new Error(`Published staging model ${key} route mismatch: ${current.route ?? current.definition.route}`);
  }
  if (baselineModelSemanticsMatch(current.definition, expected)) {
    unchanged.push({ key, version: current.version, schemaHash: current.schemaHash });
    continue;
  }

  const definition = applyBaselineModelSemantics(current.definition, expected);
  const result = await modelAdminRequest("/api/v1/model-admin/models", {
    method: "POST",
    body: { definition, compatibility: "compatible" },
  });
  if (result.response.status !== 201 || result.payload?.data?.key !== key) {
    throw new Error(`Could not publish staging model ${key}: ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  published.push({
    key,
    previousVersion: current.version,
    version: result.payload.data.version,
    schemaHash: result.payload.data.schemaHash,
  });
}

const verified = await modelAdminRequest("/api/v1/model-admin/models");
if (verified.response.status !== 200 || !Array.isArray(verified.payload?.data)) {
  throw new Error(`Could not verify staging models: ${verified.response.status} ${JSON.stringify(verified.payload)}`);
}
const verifiedByKey = new Map(verified.payload.data.map((model) => [model.key, model]));
for (const [key, expected] of Object.entries(BASELINE_MODEL_SEMANTICS)) {
  const model = verifiedByKey.get(key);
  if (!model?.definition || !baselineModelSemanticsMatch(model.definition, expected)) {
    throw new Error(`Staging model ${key} semantic metadata did not converge`);
  }
}

const active = await modelAdminRequest("/api/v1/model-admin/contracts/active");
if (active.response.status !== 200 || !/^mct_[a-f0-9]{64}$/u.test(active.payload?.data?.id ?? "")) {
  throw new Error(`Could not read active staging Model Contract: ${active.response.status} ${JSON.stringify(active.payload)}`);
}

console.log(JSON.stringify({
  ok: true,
  published,
  unchanged,
  activeModelContract: active.payload.data.id,
  models: Object.fromEntries(Object.keys(BASELINE_MODEL_SEMANTICS).map((key) => {
    const model = verifiedByKey.get(key);
    return [key, { version: model.version, schemaHash: model.schemaHash }];
  })),
}, null, 2));

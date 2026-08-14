import process from "node:process";
import { PRODUCTION_EXPECTATIONS, assertProductionServiceUrl } from "./production-expectations.mjs";

const coreBase = (process.env.LIFESPACE_CORE_PRODUCTION_URL ?? "https://core.aisr.online").replace(/\/+$/u, "");
const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
assertProductionServiceUrl(coreBase, "core");
assertProductionServiceUrl(identityBase, "identity");

async function json(url) {
  const response = await fetch(url);
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; }
  catch { throw new Error(`${url} returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`); }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload?.data;
}

const coreHealth = await json(`${coreBase}/health`);
const identityHealth = await json(`${identityBase}/health`);
if (coreHealth?.status !== "ok" || identityHealth?.status !== "ok") throw new Error("Production health endpoints did not return ok");

const coreStatus = await json(`${coreBase}/api/v1/status`);
const identityStatus = await json(`${identityBase}/api/v1/status`);
if (coreStatus?.environment !== "production") throw new Error(`Core environment mismatch: ${coreStatus?.environment}`);
if (identityStatus?.environment !== "production") throw new Error(`Identity environment mismatch: ${identityStatus?.environment}`);
if (coreStatus?.contractVersion !== PRODUCTION_EXPECTATIONS.core.contractVersion || Number(coreStatus?.schemaVersion) !== PRODUCTION_EXPECTATIONS.core.schemaVersion) {
  throw new Error(`Core production contract/schema mismatch: ${JSON.stringify(coreStatus)}`);
}
if (identityStatus?.contractVersion !== PRODUCTION_EXPECTATIONS.identity.contractVersion || Number(identityStatus?.schemaVersion) !== PRODUCTION_EXPECTATIONS.identity.schemaVersion) {
  throw new Error(`Identity production contract/schema mismatch: ${JSON.stringify(identityStatus)}`);
}

console.log(JSON.stringify({
  ok: true,
  core: { contractVersion: coreStatus.contractVersion, schemaVersion: Number(coreStatus.schemaVersion) },
  identity: { contractVersion: identityStatus.contractVersion, schemaVersion: Number(identityStatus.schemaVersion) },
  environment: "production",
}, null, 2));

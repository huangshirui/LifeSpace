import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { STAGING_EXPECTATIONS, assertStagingServiceUrl } from "./staging-expectations.mjs";

export function assertStagingStatus(payload, expected, service) {
  const data = payload?.data;
  if (!data || typeof data !== "object") throw new Error(`${service} staging status payload is missing data`);
  if (data.environment !== "staging") {
    throw new Error(`${service} staging environment mismatch: expected staging, got ${JSON.stringify(data.environment)}`);
  }
  if (String(data.schemaVersion) !== String(expected.schemaVersion)) {
    throw new Error(`${service} staging schema mismatch: expected ${expected.schemaVersion}, got ${JSON.stringify(data.schemaVersion)}`);
  }
  if (data.contractVersion !== expected.contractVersion) {
    throw new Error(`${service} staging contract mismatch: expected ${expected.contractVersion}, got ${JSON.stringify(data.contractVersion)}`);
  }
  return Object.freeze({
    environment: data.environment,
    schemaVersion: Number(data.schemaVersion),
    contractVersion: data.contractVersion,
  });
}

async function fetchStatus(baseUrl, service, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/api/v1/status`, { headers: { accept: "application/json" } });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${service} staging status returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  }
  if (!response.ok) throw new Error(`${service} staging status failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

export async function verifyStagingCandidateIdentity({ coreBaseUrl, identityBaseUrl, fetchImpl = fetch }) {
  const coreUrl = coreBaseUrl.replace(/\/+$/u, "");
  const identityUrl = identityBaseUrl.replace(/\/+$/u, "");
  assertStagingServiceUrl(coreUrl, "core");
  assertStagingServiceUrl(identityUrl, "identity");

  const [corePayload, identityPayload] = await Promise.all([
    fetchStatus(coreUrl, "Core", fetchImpl),
    fetchStatus(identityUrl, "Identity", fetchImpl),
  ]);

  return Object.freeze({
    core: assertStagingStatus(corePayload, STAGING_EXPECTATIONS.core, "Core"),
    identity: assertStagingStatus(identityPayload, STAGING_EXPECTATIONS.identity, "Identity"),
  });
}

async function main() {
  const result = await verifyStagingCandidateIdentity({
    coreBaseUrl: process.env.LIFESPACE_CORE_STAGING_URL ?? "",
    identityBaseUrl: process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "",
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();

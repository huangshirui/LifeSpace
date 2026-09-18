import process from "node:process";
import { fileURLToPath } from "node:url";

function statusData(payload) {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

export function compareContractVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || [...a, ...b].some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Unsupported contract version comparison: ${left} vs ${right}`);
  }
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function assertStagingCandidateNotOlder({ service, live, expectedContractVersion, expectedSchemaVersion }) {
  const data = statusData(live);
  if (!data || typeof data !== "object") throw new Error(`${service} staging status payload is invalid`);
  if (data.status !== "ok") throw new Error(`${service} staging status is not ok`);
  if (data.environment !== "staging") {
    throw new Error(`${service} status is not staging: ${String(data.environment ?? "unknown")}`);
  }

  const liveSchema = Number(data.schemaVersion);
  const expectedSchema = Number(expectedSchemaVersion);
  if (!Number.isInteger(liveSchema) || !Number.isInteger(expectedSchema)) {
    throw new Error(`${service} schema version is invalid`);
  }
  if (liveSchema > expectedSchema) {
    throw new Error(
      `${service} staging schema ${liveSchema} is newer than candidate schema ${expectedSchema}; refusing a staging downgrade before migration/deploy`,
    );
  }

  const liveContract = String(data.contractVersion ?? "");
  if (compareContractVersions(liveContract, expectedContractVersion) > 0) {
    throw new Error(
      `${service} staging contract ${liveContract} is newer than candidate contract ${expectedContractVersion}; refusing a staging downgrade before deploy`,
    );
  }

  return {
    service,
    liveContractVersion: liveContract,
    liveSchemaVersion: liveSchema,
    expectedContractVersion,
    expectedSchemaVersion: expectedSchema,
  };
}

async function fetchStatus(baseUrl, service) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${String(baseUrl).replace(/\/+$/u, "")}/api/v1/status`, {
        headers: { accept: "application/json" },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(`${service} status returned HTTP ${response.status}`);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${service} staging status check failed`);
}

export async function verifyStagingCandidateCompatibility({
  coreBaseUrl,
  identityBaseUrl,
  expectedCoreContractVersion,
  expectedCoreSchemaVersion,
  expectedIdentityContractVersion,
  expectedIdentitySchemaVersion,
}) {
  const [core, identity] = await Promise.all([
    fetchStatus(coreBaseUrl, "core"),
    fetchStatus(identityBaseUrl, "identity"),
  ]);
  return {
    core: assertStagingCandidateNotOlder({
      service: "core",
      live: core,
      expectedContractVersion: expectedCoreContractVersion,
      expectedSchemaVersion: expectedCoreSchemaVersion,
    }),
    identity: assertStagingCandidateNotOlder({
      service: "identity",
      live: identity,
      expectedContractVersion: expectedIdentityContractVersion,
      expectedSchemaVersion: expectedIdentitySchemaVersion,
    }),
  };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const required = [
    "LIFESPACE_CORE_STAGING_URL",
    "LIFESPACE_IDENTITY_STAGING_URL",
    "LIFESPACE_EXPECTED_CORE_CONTRACT_VERSION",
    "LIFESPACE_EXPECTED_CORE_SCHEMA_VERSION",
    "LIFESPACE_EXPECTED_IDENTITY_CONTRACT_VERSION",
    "LIFESPACE_EXPECTED_IDENTITY_SCHEMA_VERSION",
  ];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }

  const result = await verifyStagingCandidateCompatibility({
    coreBaseUrl: process.env.LIFESPACE_CORE_STAGING_URL,
    identityBaseUrl: process.env.LIFESPACE_IDENTITY_STAGING_URL,
    expectedCoreContractVersion: process.env.LIFESPACE_EXPECTED_CORE_CONTRACT_VERSION,
    expectedCoreSchemaVersion: process.env.LIFESPACE_EXPECTED_CORE_SCHEMA_VERSION,
    expectedIdentityContractVersion: process.env.LIFESPACE_EXPECTED_IDENTITY_CONTRACT_VERSION,
    expectedIdentitySchemaVersion: process.env.LIFESPACE_EXPECTED_IDENTITY_SCHEMA_VERSION,
  });
  console.log(JSON.stringify(result, null, 2));
}

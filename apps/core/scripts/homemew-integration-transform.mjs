import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const LEGACY_MODEL_PERMISSIONS = new Map([
  ["events:read", { modelKey: "event", permission: "read" }],
  ["events:write", { modelKey: "event", permission: "write" }],
  ["tasks:read", { modelKey: "task", permission: "read" }],
  ["tasks:write", { modelKey: "task", permission: "write" }],
  ["day-records:read", { modelKey: "day_record", permission: "read" }],
  ["day-records:write", { modelKey: "day_record", permission: "write" }],
]);
const SUPPORTED_PERMISSIONS = new Set(["family:read", ...LEGACY_MODEL_PERMISSIONS.keys()]);
const permissionRank = { read: 1, write: 2 };

function fail(message) { throw new Error(`HomeMew integration snapshot is invalid: ${message}`); }
function array(value, field) { if (!Array.isArray(value)) fail(`${field} must be an array`); return value; }
function string(value, field) { if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`); return value.trim(); }
function instant(value, field, nullable = false) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  const result = string(value, field);
  if (!result.endsWith("Z") || Number.isNaN(Date.parse(result))) fail(`${field} must be an RFC 3339 UTC instant`);
  return result;
}
function sql(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}
function deterministicId(prefix, namespace, legacyId) {
  return `${prefix}_${createHash("sha256").update(`${namespace}\0${legacyId}`).digest("hex").slice(0, 32)}`;
}
function unique(items, field) {
  const result = new Map();
  for (const item of items) {
    const id = string(item.id, `${field}.id`);
    if (result.has(id)) fail(`${field} contains duplicate id ${id}`);
    result.set(id, item);
  }
  return result;
}
function permissions(value, field) {
  const values = array(value, field).map((permission, index) => string(permission, `${field}[${index}]`));
  if (new Set(values).size !== values.length) fail(`${field} contains duplicates`);
  for (const permission of values) if (!SUPPORTED_PERMISSIONS.has(permission)) fail(`${field} contains unsupported permission ${permission}`);
  for (const model of ["events", "tasks", "day-records"]) {
    if (values.includes(`${model}:write`) && !values.includes(`${model}:read`)) fail(`${field} ${model}:write requires ${model}:read`);
  }

  const modelGrants = new Map();
  for (const legacyPermission of values) {
    const mapped = LEGACY_MODEL_PERMISSIONS.get(legacyPermission);
    if (!mapped) continue;
    const current = modelGrants.get(mapped.modelKey);
    if (!current || permissionRank[mapped.permission] > permissionRank[current]) modelGrants.set(mapped.modelKey, mapped.permission);
  }
  const scopes = [];
  if (values.includes("family:read")) scopes.push("spaces:read");
  if (modelGrants.size) scopes.push("resources:read");
  if ([...modelGrants.values()].some((permission) => permission === "write")) scopes.push("resources:write");
  return {
    scopes,
    wholeSpacePermission: values.includes("family:read") ? "read" : null,
    modelGrants: [...modelGrants.entries()].map(([modelKey, permission]) => ({ modelKey, permission })),
  };
}

export function transformIntegrationSnapshot(snapshot, familyMapping, clientId = "homemew-external") {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("root must be an object");
  if (String(snapshot.source?.schemaVersion) !== "11") fail("source.schemaVersion must be 11");
  const migratedAt = instant(snapshot.source?.exportedAt, "source.exportedAt");
  const systems = array(snapshot.systemIdentities ?? [], "systemIdentities");
  const accesses = array(snapshot.familySystemAccess ?? [], "familySystemAccess");
  const credentials = array(snapshot.systemCredentials ?? [], "systemCredentials");
  const systemsById = unique(systems, "systemIdentities");
  const credentialsById = unique(credentials, "systemCredentials");
  void credentialsById;

  if (!familyMapping || typeof familyMapping !== "object") fail("family mapping manifest is required");
  const familyMap = new Map(array(familyMapping.families ?? [], "familyMapping.families").map((entry) => [string(entry.legacyFamilyId, "legacyFamilyId"), string(entry.spaceId, "spaceId")]));
  const userMap = new Map(array(familyMapping.users ?? [], "familyMapping.users").map((entry) => [string(entry.legacyUserId, "legacyUserId"), string(entry.lifespaceUserId, "lifespaceUserId")]));
  const accessBySystem = new Map();
  for (const access of accesses) {
    const systemId = string(access.systemId, "familySystemAccess.systemId");
    const familyId = string(access.familyId, "familySystemAccess.familyId");
    if (!systemsById.has(systemId)) fail(`access references missing system ${systemId}`);
    if (!familyMap.has(familyId)) fail(`access references unmapped family ${familyId}`);
    if (accessBySystem.has(systemId)) fail(`system ${systemId} has multiple family access rows`);
    if (!["active", "disabled"].includes(access.status)) fail(`access ${systemId} has invalid status`);
    accessBySystem.set(systemId, access);
  }

  const identitySql = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  const coreSql = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];
  const principalMappings = [];
  const credentialMappings = [];
  let grantCount = 0;

  for (const system of systems) {
    const familyId = string(system.familyId, `system ${system.id}.familyId`);
    const access = accessBySystem.get(system.id);
    if (!access) fail(`system ${system.id} has no family_system_access row`);
    if (access.familyId !== familyId) fail(`system ${system.id} family does not match access row`);
    if (!familyMap.has(familyId)) fail(`system ${system.id} references unmapped family ${familyId}`);
    if (!["active", "disabled", "deleted"].includes(system.status)) fail(`system ${system.id} has invalid status`);
    const createdBy = userMap.get(string(system.createdByUserId, `system ${system.id}.createdByUserId`));
    if (!createdBy) fail(`system ${system.id} references unmapped creator ${system.createdByUserId}`);
    const authority = permissions(access.permissions, `system ${system.id}.permissions`);
    const principalId = deterministicId("svc", "homemew-system", system.id);
    const active = system.status === "active" && access.status === "active";
    const createdAt = instant(system.createdAt, `system ${system.id}.createdAt`);
    const updatedAt = instant(system.updatedAt, `system ${system.id}.updatedAt`);
    const disabledAt = active ? null : updatedAt;
    const description = system.description === null || system.description === undefined ? null : String(system.description).trim() || null;
    if (description && description.length > 500) fail(`system ${system.id}.description is too long`);
    identitySql.push(`INSERT INTO service_principals(id,application_id,display_name,description,max_scopes,status,created_by_user_id,created_at,updated_at,disabled_at) VALUES(${[
      principalId, clientId, string(system.name, `system ${system.id}.name`), description, JSON.stringify(authority.scopes), active ? "active" : "disabled", createdBy, createdAt, updatedAt, disabledAt,
    ].map(sql).join(",")});`);

    const grants = [];
    const revokedAt = active ? null : (access.updatedAt ?? updatedAt);
    const grantCreatedAt = access.createdAt ?? createdAt;
    if (authority.wholeSpacePermission) {
      grants.push({
        id: deterministicId("grt", "homemew-system-space-grant", system.id),
        resourceType: "space",
        resourceId: null,
        permission: authority.wholeSpacePermission,
      });
    }
    for (const modelGrant of authority.modelGrants) {
      grants.push({
        id: deterministicId("grt", `homemew-system-model-grant:${modelGrant.modelKey}`, system.id),
        resourceType: "model",
        resourceId: modelGrant.modelKey,
        permission: modelGrant.permission,
      });
    }
    for (const grant of grants) {
      coreSql.push(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at,revoked_at) VALUES(${[
        grant.id, familyMap.get(familyId), "service", principalId, grant.resourceType, grant.resourceId, grant.permission, createdBy, grantCreatedAt, null, revokedAt,
      ].map(sql).join(",")});`);
      grantCount += 1;
    }
    principalMappings.push({
      legacySystemId: system.id,
      servicePrincipalId: principalId,
      legacyFamilyId: familyId,
      spaceId: familyMap.get(familyId),
      scopes: authority.scopes,
      grants,
      status: active ? "active" : "disabled",
    });
  }

  for (const credential of credentials) {
    const systemId = string(credential.systemId, `credential ${credential.id}.systemId`);
    if (!systemsById.has(systemId)) fail(`credential ${credential.id} references missing system ${systemId}`);
    if (!["api_token", "oauth_client_secret"].includes(credential.credentialType)) fail(`credential ${credential.id} has invalid credentialType`);
    if (!["active", "revoked"].includes(credential.status)) fail(`credential ${credential.id} has invalid status`);
    instant(credential.createdAt, `credential ${credential.id}.createdAt`);
    instant(credential.expiresAt, `credential ${credential.id}.expiresAt`, true);
    instant(credential.revokedAt, `credential ${credential.id}.revokedAt`, true);
    credentialMappings.push({
      legacyCredentialId: credential.id,
      legacySystemId: systemId,
      servicePrincipalId: deterministicId("svc", "homemew-system", systemId),
      legacyCredentialType: credential.credentialType,
      legacyStatus: credential.status,
      replacementMode: credential.credentialType === "api_token" ? "service_api_token" : "oauth_client_credentials",
      requiresNewSecret: true,
    });
  }
  identitySql.push("COMMIT;");
  coreSql.push("COMMIT;");

  const manifest = {
    version: 2,
    source: { schemaVersion: "11", exportedAt: migratedAt, commit: snapshot.source?.commit ?? null },
    clientId,
    principals: principalMappings,
    credentials: credentialMappings,
  };
  const report = {
    status: "ready_requires_credential_rotation",
    principals: principalMappings.length,
    activePrincipals: principalMappings.filter((entry) => entry.status === "active").length,
    grants: grantCount,
    legacyCredentials: credentialMappings.length,
    credentialsRequiringReplacement: credentialMappings.filter((entry) => entry.legacyStatus === "active").length,
    secretsCopied: 0,
    notes: [
      "Legacy HomeMew model permissions are preserved as model-scoped LifeSpace Data Grants, not model-specific token scopes.",
      "Legacy HomeMew credential plaintext and hashes are intentionally not copied.",
      "Issue a new lsp_pat_* token or OAuth client credential for every active integration before cutover.",
      "Revoke old HomeMew credentials only after LifeSpace staging verification and the production rollback window.",
    ],
  };
  return { identitySql: `${identitySql.join("\n")}\n`, coreSql: `${coreSql.join("\n")}\n`, manifest, report };
}

async function main(argv) {
  const inputIndex = argv.indexOf("--input");
  const mappingIndex = argv.indexOf("--family-mapping");
  const outputIndex = argv.indexOf("--out-dir");
  const clientIndex = argv.indexOf("--client-id");
  if (inputIndex < 0 || mappingIndex < 0 || outputIndex < 0 || !argv[inputIndex + 1] || !argv[mappingIndex + 1] || !argv[outputIndex + 1]) {
    throw new Error("Usage: node scripts/homemew-integration-transform.mjs --input integrations.json --family-mapping mapping-manifest.json --out-dir DIR [--client-id homemew-external]");
  }
  const [snapshot, mapping] = await Promise.all([
    readFile(path.resolve(argv[inputIndex + 1]), "utf8").then(JSON.parse),
    readFile(path.resolve(argv[mappingIndex + 1]), "utf8").then(JSON.parse),
  ]);
  const result = transformIntegrationSnapshot(snapshot, mapping, clientIndex >= 0 && argv[clientIndex + 1] ? argv[clientIndex + 1] : "homemew-external");
  const outputDir = path.resolve(argv[outputIndex + 1]);
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "identity-service-auth.sql"), result.identitySql),
    writeFile(path.join(outputDir, "core-service-grants.sql"), result.coreSql),
    writeFile(path.join(outputDir, "integration-mapping-manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`),
    writeFile(path.join(outputDir, "credential-rotation-report.json"), `${JSON.stringify(result.report, null, 2)}\n`),
  ]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

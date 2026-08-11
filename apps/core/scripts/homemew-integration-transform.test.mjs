import assert from "node:assert/strict";
import test from "node:test";
import { transformIntegrationSnapshot } from "./homemew-integration-transform.mjs";

const mapping = {
  users: [{ legacyUserId: "usr_owner", lifespaceUserId: "usr_owner" }],
  families: [{ legacyFamilyId: "fam_home", spaceId: "spc_home" }],
};

function snapshot() {
  return {
    source: { schemaVersion: 11, exportedAt: "2026-08-11T10:00:00.000Z", commit: "homemew-source" },
    systemIdentities: [{
      id: "sys_n8n",
      familyId: "fam_home",
      name: "Home n8n",
      description: "Automation",
      status: "active",
      createdByUserId: "usr_owner",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }],
    familySystemAccess: [{
      familyId: "fam_home",
      systemId: "sys_n8n",
      status: "active",
      permissions: ["family:read", "events:read", "events:write", "tasks:read"],
      createdByUserId: "usr_owner",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    }],
    systemCredentials: [
      { id: "cred_pat", systemId: "sys_n8n", credentialType: "api_token", status: "active", secretHash: "SHOULD_NOT_COPY", createdAt: "2026-08-01T00:00:00.000Z", expiresAt: null, revokedAt: null },
      { id: "cred_oauth", systemId: "sys_n8n", credentialType: "oauth_client_secret", status: "revoked", secretHash: "ALSO_DO_NOT_COPY", createdAt: "2026-08-02T00:00:00.000Z", expiresAt: null, revokedAt: "2026-08-09T00:00:00.000Z" },
    ],
  };
}

test("maps HomeMew external integration to service principal + Data Grant without copying credentials", () => {
  const result = transformIntegrationSnapshot(snapshot(), mapping, "homemew-external");
  assert.match(result.identitySql, /INSERT INTO service_principals/);
  assert.match(result.identitySql, /homemew-external/);
  assert.match(result.identitySql, /events:read/);
  assert.match(result.identitySql, /events:write/);
  assert.match(result.coreSql, /'service'/);
  assert.match(result.coreSql, /'write'/);
  assert.equal(result.manifest.principals[0].spaceId, "spc_home");
  assert.deepEqual(result.manifest.principals[0].scopes, ["spaces:read", "events:read", "events:write", "tasks:read"]);
  assert.equal(result.manifest.credentials[0].requiresNewSecret, true);
  assert.equal(result.report.credentialsRequiringReplacement, 1);
  assert.equal(result.report.secretsCopied, 0);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SHOULD_NOT_COPY|ALSO_DO_NOT_COPY/);
});

test("requires write permission dependencies and mapped family/user references", () => {
  const invalid = snapshot();
  invalid.familySystemAccess[0].permissions = ["events:write"];
  assert.throws(() => transformIntegrationSnapshot(invalid, mapping), /events:write requires events:read/);

  const missingFamily = snapshot();
  missingFamily.systemIdentities[0].familyId = "fam_missing";
  assert.throws(() => transformIntegrationSnapshot(missingFamily, mapping), /unmapped family/);
});

test("disabled integration produces disabled principal and revoked grant", () => {
  const disabled = snapshot();
  disabled.systemIdentities[0].status = "disabled";
  const result = transformIntegrationSnapshot(disabled, mapping);
  assert.match(result.identitySql, /'disabled'/);
  assert.match(result.coreSql, /2026-08-10T00:00:00\.000Z/);
  assert.equal(result.manifest.principals[0].status, "disabled");
});

import process from "node:process";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const applicationSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const applicationId = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID ?? "";
const userBearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const servicePrincipalId = process.env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const CORE_DIR = new URL("../../apps/core/", import.meta.url);

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: applicationSecret,
  LIFESPACE_STAGING_SMOKE_APPLICATION_ID: applicationId,
  LIFESPACE_STAGING_USER_BEARER: userBearer,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID: servicePrincipalId,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
})) {
  if (!value) throw new Error(`${name} is required`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function request(base, path, { method = "GET", bearer, delegationId, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(delegationId ? { "x-lifespace-delegation-id": delegationId } : {}),
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

function expectStatus(result, expected, label) {
  if (result.response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

function requireId(value, prefix, label) {
  if (typeof value !== "string" || !value.startsWith(prefix)) throw new Error(`${label} did not return ${prefix}*: ${JSON.stringify(value)}`);
  return value;
}

async function ensurePersonGroupApplicationAccess() {
  const now = new Date().toISOString();
  await executeStagingD1Sql({
    cwd: CORE_DIR,
    sql: `INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(
      ${sqlString(applicationId)},'person_group','write','service',${sqlString(servicePrincipalId)},${sqlString(now)},${sqlString(now)}
    ) ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`,
  });
}

async function createAgent() {
  const result = await request(identityBase, "/internal/v1/agents", {
    method: "POST",
    bearer: applicationSecret,
    body: { displayName: `Platform Golden Flow Agent ${runId}` },
  });
  const data = expectStatus(result, 201, "Golden Flow Agent identity creation");
  return requireId(data?.id, "agt_", "Golden Flow Agent identity");
}

async function issueAgentCredential(agentId) {
  const result = await request(identityBase, `/internal/v1/agents/${encodeURIComponent(agentId)}/api-credentials`, {
    method: "POST",
    bearer: applicationSecret,
    body: {
      label: `Platform Golden Flow ${runId}`,
      scopes: ["resources:read", "resources:write"],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  });
  const data = expectStatus(result, 201, "Golden Flow Agent API credential issuance");
  const credentialId = requireId(data?.id, "agc_", "Golden Flow Agent API credential id");
  const token = requireId(data?.token, "lsp_agt_", "Golden Flow Agent API credential token");
  console.log(`::add-mask::${token}`);
  return { credentialId, token };
}

async function revokeAgentCredential(agentId, credentialId) {
  const result = await request(identityBase, `/internal/v1/agents/${encodeURIComponent(agentId)}/api-credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
    bearer: applicationSecret,
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    throw new Error(`Golden Flow Agent API credential revoke failed: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

async function createAuthorizationRequest(agentBearer) {
  const requestBody = {
    principalUserId: userId,
    requestTtlMinutes: 15,
    correlation: { sessionId: `staging-golden-flow-${runId}` },
    items: [
      { scope: { target: { type: "space", id: spaceId }, maxAccess: "write" } },
      { scope: { target: { type: "model", id: "task" }, maxAccess: "write" } },
      { scope: { target: { type: "model", id: "person_group" }, maxAccess: "write" } },
    ],
  };
  const created = await request(coreBase, `/api/v1/spaces/${spaceId}/authorization-requests`, {
    method: "POST",
    bearer: agentBearer,
    body: requestBody,
  });
  const data = expectStatus(created, 201, "Authorization Request create");
  const requestId = requireId(data?.id, "arq_", "Authorization Request");
  if (data.status !== "pending" || data.reused !== false || !data.confirmation || data.delegations?.length) {
    throw new Error(`New Authorization Request must be pending and non-authorizing: ${JSON.stringify(data)}`);
  }

  const reused = await request(coreBase, `/api/v1/spaces/${spaceId}/authorization-requests`, {
    method: "POST",
    bearer: agentBearer,
    body: requestBody,
  });
  const reusedData = expectStatus(reused, 200, "Authorization Request pending reuse");
  if (reusedData?.id !== requestId || reusedData?.status !== "pending" || reusedData?.reused !== true) {
    throw new Error(`Identical pending Authorization Request was not reused: ${JSON.stringify(reusedData)}`);
  }
  return { requestId, confirmation: data.confirmation };
}

async function confirmAuthorizationRequest(agentBearer, requestId, confirmation) {
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/authorization-requests/${encodeURIComponent(requestId)}/confirm`, {
    method: "POST",
    bearer: agentBearer,
    body: { principalUserId: userId, confirmation },
  });
  const data = expectStatus(result, 200, "Authorization Request confirm");
  if (data?.status !== "approved" || !Array.isArray(data?.delegations) || data.delegations.length !== 3) {
    throw new Error(`Authorization Request did not atomically issue three Delegations: ${JSON.stringify(data)}`);
  }
  for (const delegation of data.delegations) {
    requireId(delegation?.id, "dlg_", "Authorization Request Delegation");
    if (delegation?.principal?.type !== "user" || delegation?.principal?.id !== userId || delegation?.actor?.type !== "agent") {
      throw new Error(`Authorization Request Delegation Principal/Actor mismatch: ${JSON.stringify(delegation)}`);
    }
  }
  return data.delegations;
}

function delegationFor(delegations, type, id) {
  const delegation = delegations.find((entry) => entry?.scope?.target?.type === type && entry?.scope?.target?.id === id);
  if (!delegation) throw new Error(`Missing ${type}:${id} Delegation in ${JSON.stringify(delegations)}`);
  return delegation.id;
}

async function createPerson(agentBearer, spaceDelegationId) {
  const displayName = `Golden Person ${runId}`;
  const alias = `Golden Alias ${runId}`;
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/people`, {
    method: "POST",
    bearer: agentBearer,
    delegationId: spaceDelegationId,
    body: { displayName, alternateNames: [alias] },
  });
  const data = expectStatus(result, 201, "Person create through confirmed Delegation");
  return {
    personId: requireId(data?.id, "per_", "Created Person"),
    version: data?.version,
    displayName,
    alias,
  };
}

async function verifyAndUpdatePerson(agentBearer, spaceDelegationId, person) {
  const getResult = await request(coreBase, `/api/v1/spaces/${spaceId}/people/${encodeURIComponent(person.personId)}`, {
    bearer: agentBearer,
    delegationId: spaceDelegationId,
  });
  const current = expectStatus(getResult, 200, "Person get through confirmed Delegation");
  if (current?.displayName !== person.displayName || !current?.alternateNames?.includes(person.alias)) {
    throw new Error(`Person get projection mismatch: ${JSON.stringify(current)}`);
  }

  const search = await request(coreBase, `/api/v1/spaces/${spaceId}/people?q=${encodeURIComponent(person.alias)}`, {
    bearer: agentBearer,
    delegationId: spaceDelegationId,
  });
  const page = expectStatus(search, 200, "Person alternate-name search");
  if (!page?.items?.some((entry) => entry.id === person.personId && entry.displayName === person.displayName)) {
    throw new Error(`Person alternate-name search did not return canonical Person: ${JSON.stringify(page)}`);
  }

  const updatedDisplayName = `Golden Person Updated ${runId}`;
  const renamedAlias = `Golden Alias Renamed ${runId}`;
  const addedAlias = `Golden Alias Added ${runId}`;
  const update = await request(coreBase, `/api/v1/spaces/${spaceId}/people/${encodeURIComponent(person.personId)}`, {
    method: "PATCH",
    bearer: agentBearer,
    delegationId: spaceDelegationId,
    body: {
      version: current.version,
      displayName: updatedDisplayName,
      alternateNames: {
        rename: [{ from: person.alias, to: renamedAlias }],
        add: [addedAlias],
      },
    },
  });
  const data = expectStatus(update, 200, "Person display/alias update");
  if (data?.displayName !== updatedDisplayName || !data?.alternateNames?.includes(renamedAlias) || !data?.alternateNames?.includes(addedAlias)) {
    throw new Error(`Person update result mismatch: ${JSON.stringify(data)}`);
  }

  const renamedSearch = await request(coreBase, `/api/v1/spaces/${spaceId}/people?q=${encodeURIComponent(renamedAlias)}`, {
    bearer: agentBearer,
    delegationId: spaceDelegationId,
  });
  const renamedPage = expectStatus(renamedSearch, 200, "Person renamed-alias search");
  if (!renamedPage?.items?.some((entry) => entry.id === person.personId && entry.displayName === updatedDisplayName)) {
    throw new Error(`Renamed Person alias did not resolve to canonical Person: ${JSON.stringify(renamedPage)}`);
  }
  return { ...person, version: data.version, displayName: updatedDisplayName, renamedAlias, addedAlias };
}

async function createPersonGroup(agentBearer, groupDelegationId, person) {
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/models/person_group/records`, {
    method: "POST",
    bearer: agentBearer,
    delegationId: groupDelegationId,
    body: {
      name: `Golden Group ${runId}`,
      description: "Staging Golden Flow Person relation proof",
      memberPersonIds: [person.personId],
    },
  });
  const data = expectStatus(result, 201, "Person Group create with Person relation");
  const recordId = requireId(data?.id, "rec_", "Created Person Group");
  if (!Array.isArray(data?.memberPersonIds) || !data.memberPersonIds.includes(person.personId)) {
    throw new Error(`Person Group did not persist memberPersonIds relation: ${JSON.stringify(data)}`);
  }

  const targets = await request(
    coreBase,
    `/api/v1/spaces/${spaceId}/_relation-targets/person_group/memberPersonIds?q=${encodeURIComponent(person.displayName)}`,
    { bearer: agentBearer, delegationId: groupDelegationId },
  );
  const targetPage = expectStatus(targets, 200, "Person Group member relation-target lookup");
  if (!targetPage?.items?.some((entry) => entry.id === person.personId && entry.label === person.displayName)) {
    throw new Error(`Person relation-target projection mismatch: ${JSON.stringify(targetPage)}`);
  }
  return { recordId, version: data.version };
}

async function createTask(agentBearer, taskDelegationId, name) {
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/models/task/records`, {
    method: "POST",
    bearer: agentBearer,
    delegationId: taskDelegationId,
    body: { name },
  });
  const data = expectStatus(result, 201, `Task seed create (${name})`);
  return { recordId: requireId(data?.id, "rec_", "Task seed"), version: data?.version };
}

async function verifyBulkPartialSuccess(agentBearer, taskDelegationId) {
  const updateSeed = await createTask(agentBearer, taskDelegationId, `Golden Bulk Update Seed ${runId}`);
  const deleteSeed = await createTask(agentBearer, taskDelegationId, `Golden Bulk Delete Seed ${runId}`);
  const updatedName = `Golden Bulk Updated ${runId}`;
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/models/bulk`, {
    method: "POST",
    bearer: agentBearer,
    body: {
      operations: [
        { operation: "create", modelKey: "task", delegationId: taskDelegationId, data: { name: `Golden Bulk Created ${runId}` } },
        { operation: "update", modelKey: "task", recordId: updateSeed.recordId, delegationId: taskDelegationId, data: { name: updatedName } },
        { operation: "delete", modelKey: "task", recordId: deleteSeed.recordId, delegationId: taskDelegationId },
        { operation: "create", modelKey: "task", delegationId: taskDelegationId, data: {} },
      ],
    },
  });
  const data = expectStatus(result, 200, "Non-atomic Bulk mixed CRUD partial-success request");
  requireId(data?.bulkId, "blk_", "Non-atomic Bulk correlation");
  if (!Array.isArray(data?.items) || data.items.length !== 4) throw new Error(`Bulk result item count mismatch: ${JSON.stringify(data)}`);
  const statuses = data.items.map((entry) => entry.status);
  if (JSON.stringify(statuses) !== JSON.stringify(["succeeded", "succeeded", "succeeded", "failed"])) {
    throw new Error(`Bulk did not preserve independent per-item outcomes: ${JSON.stringify(data.items)}`);
  }
  const createdRecordId = requireId(data.items[0]?.recordId, "rec_", "Bulk-created task");
  if (!data.items[3]?.error?.code || Number(data.items[3]?.error?.status) < 400) {
    throw new Error(`Bulk failed item omitted structured error: ${JSON.stringify(data.items[3])}`);
  }

  const updated = await request(coreBase, `/api/v1/spaces/${spaceId}/models/task/records/${encodeURIComponent(updateSeed.recordId)}`, {
    bearer: agentBearer,
    delegationId: taskDelegationId,
  });
  const updatedData = expectStatus(updated, 200, "Bulk-updated task readback");
  if (updatedData?.name !== updatedName) throw new Error(`Bulk update did not persist: ${JSON.stringify(updatedData)}`);

  const deleted = await request(coreBase, `/api/v1/spaces/${spaceId}/models/task/records/${encodeURIComponent(deleteSeed.recordId)}`, {
    bearer: agentBearer,
    delegationId: taskDelegationId,
  });
  if (deleted.response.status !== 404) {
    throw new Error(`Bulk-deleted task remained readable: HTTP ${deleted.response.status} ${JSON.stringify(deleted.payload)}`);
  }

  return {
    cleanupRecordIds: [createdRecordId, updateSeed.recordId],
    bulkId: data.bulkId,
  };
}

async function cleanupOrdinaryRecords(agentBearer, operations) {
  if (!operations.length) return;
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/models/bulk`, {
    method: "POST",
    bearer: agentBearer,
    body: { operations },
  });
  if (result.response.status !== 200) {
    console.warn(`Golden Flow ordinary-record cleanup failed: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

async function deletePerson(agentBearer, spaceDelegationId, person) {
  if (!person?.personId || !person?.version) return;
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/people/${encodeURIComponent(person.personId)}`, {
    method: "DELETE",
    bearer: agentBearer,
    delegationId: spaceDelegationId,
    body: { version: person.version },
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    console.warn(`Golden Flow Person cleanup failed: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
}

async function revokeDelegation(delegationId) {
  const result = await request(coreBase, `/api/v1/spaces/${spaceId}/delegations/${encodeURIComponent(delegationId)}`, {
    method: "DELETE",
    bearer: userBearer,
  });
  if (result.response.status !== 204 && result.response.status !== 404) {
    console.warn(`Golden Flow Delegation cleanup failed for ${delegationId}: HTTP ${result.response.status}`);
  }
}

let agentId = "";
let credentialId = "";
let agentBearer = "";
let delegations = [];
let person = null;
let group = null;
let bulkCleanupRecordIds = [];

try {
  await ensurePersonGroupApplicationAccess();
  agentId = await createAgent();
  const credential = await issueAgentCredential(agentId);
  credentialId = credential.credentialId;
  agentBearer = credential.token;

  const authorizationRequest = await createAuthorizationRequest(agentBearer);

  const unauthorizedPerson = await request(coreBase, `/api/v1/spaces/${spaceId}/people`, {
    method: "POST",
    bearer: agentBearer,
    body: { displayName: `Must Not Exist ${runId}` },
  });
  if (unauthorizedPerson.response.status !== 403) {
    throw new Error(`Pending Authorization Request unexpectedly granted Authority: HTTP ${unauthorizedPerson.response.status} ${JSON.stringify(unauthorizedPerson.payload)}`);
  }

  delegations = await confirmAuthorizationRequest(agentBearer, authorizationRequest.requestId, authorizationRequest.confirmation);
  const spaceDelegationId = delegationFor(delegations, "space", spaceId);
  const taskDelegationId = delegationFor(delegations, "model", "task");
  const groupDelegationId = delegationFor(delegations, "model", "person_group");

  person = await createPerson(agentBearer, spaceDelegationId);
  person = await verifyAndUpdatePerson(agentBearer, spaceDelegationId, person);
  group = await createPersonGroup(agentBearer, groupDelegationId, person);

  const bulk = await verifyBulkPartialSuccess(agentBearer, taskDelegationId);
  bulkCleanupRecordIds = bulk.cleanupRecordIds;

  console.log(JSON.stringify({
    ok: true,
    scenario: "LifeSpace platform staging Golden Flow",
    agentCredential: "lsp_agt_* verified",
    authorizationRequest: "pending -> confirmed -> dlg_*",
    pendingRequestGrantsNoAuthority: true,
    personDirectory: "create/get/search/alias-update verified",
    personGroupRelation: true,
    nonAtomicBulk: "create/update/delete + partial failure verified",
    bulkId: bulk.bulkId,
    downstreamConsumersRequired: false,
  }, null, 2));
} finally {
  if (agentBearer && delegations.length) {
    try {
      const taskDelegationId = delegationFor(delegations, "model", "task");
      const groupDelegationId = delegationFor(delegations, "model", "person_group");
      const cleanupOperations = [
        ...(group?.recordId ? [{ operation: "delete", modelKey: "person_group", recordId: group.recordId, delegationId: groupDelegationId }] : []),
        ...bulkCleanupRecordIds.map((recordId) => ({ operation: "delete", modelKey: "task", recordId, delegationId: taskDelegationId })),
      ];
      await cleanupOrdinaryRecords(agentBearer, cleanupOperations);
    } catch (error) {
      console.warn(`Golden Flow ordinary-record cleanup preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (agentBearer && person && delegations.length) {
    try {
      await deletePerson(agentBearer, delegationFor(delegations, "space", spaceId), person);
    } catch (error) {
      console.warn(`Golden Flow Person cleanup preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const delegation of delegations) {
    if (!delegation?.id) continue;
    try { await revokeDelegation(delegation.id); }
    catch (error) { console.warn(`Golden Flow Delegation cleanup threw: ${error instanceof Error ? error.message : String(error)}`); }
  }

  if (agentId && credentialId) {
    try { await revokeAgentCredential(agentId, credentialId); }
    catch (error) { console.warn(`Golden Flow Agent credential cleanup threw: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

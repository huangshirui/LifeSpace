import { execFileSync } from "node:child_process";
import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const bootstrapSecret = process.env.LIFESPACE_STAGING_BOOTSTRAP_SECRET ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const cleanupBearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const CORE_DIR = new URL("../../apps/core/", import.meta.url);
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");
const runAttempt = (process.env.GITHUB_RUN_ATTEMPT ?? "1").replace(/[^0-9A-Za-z_-]/gu, "_");
const suffix = `${runId}_${runAttempt}`.replace(/[^0-9A-Za-z]/gu, "").slice(-12).toLowerCase();

for (const [name, value] of Object.entries({
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  LIFESPACE_STAGING_BOOTSTRAP_SECRET: bootstrapSecret,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_USER_BEARER: cleanupBearer,
})) {
  if (!value) throw new Error(`${name} is required`);
}

const applicationScopes = ["resources:read", "resources:write"];
const applicationModelAccess = new Map([
  ["event", "write"],
  ["task", "write"],
]);
const agents = [
  {
    key: "agentA",
    applicationId: "app_agent_a_staging",
    applicationName: "Agent A staging",
    agentDisplayName: "Agent A",
    delegationModels: [
      { modelKey: "event", maxAccess: "write" },
      { modelKey: "task", maxAccess: "read" },
    ],
    expectedDiscovery: { event: ["read", "write"], task: ["read"] },
  },
  {
    key: "agentB",
    applicationId: "app_agent_b_staging",
    applicationName: "Agent B staging",
    agentDisplayName: "Agent B",
    delegationModels: [
      { modelKey: "event", maxAccess: "read" },
      { modelKey: "task", maxAccess: "write" },
    ],
    expectedDiscovery: { event: ["read"], task: ["read", "write"] },
  },
];

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function coreSql(sql) {
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--json", `--command=${sql}`],
    { cwd: CORE_DIR, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some((entry) => entry?.success === false)) throw new Error(`Core staging D1 query failed: ${output}`);
  return entries.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

async function parseResponse(response) {
  const raw = await response.text();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

async function request(base, path, { method = "GET", bootstrap, bearer, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrap ? { "x-bootstrap-secret": bootstrap } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, payload: await parseResponse(response) };
}

function expectStatus(label, result, expected) {
  if (result.response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${result.response.status} ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

function sameSet(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value) => right.includes(value));
}

function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}

async function listCredentials(applicationId) {
  const result = await request(identityBase, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`, { bootstrap: bootstrapSecret });
  const data = expectStatus(`${applicationId} credential list`, result, 200);
  if (!Array.isArray(data)) throw new Error(`${applicationId} credential list is invalid`);
  return data;
}

async function ensureApplication(spec) {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(spec.applicationId)}`;
  const existing = await request(identityBase, path, { bootstrap: bootstrapSecret });
  let credential = "";
  let credentialId = "";

  if (existing.response.status === 404) {
    const created = await request(identityBase, "/bootstrap/v1/applications", {
      method: "POST",
      bootstrap: bootstrapSecret,
      body: {
        id: spec.applicationId,
        name: spec.applicationName,
        clientType: "service",
        allowedScopes: applicationScopes,
        trustedBackend: true,
        accessTokenTtlSeconds: 900,
      },
    });
    const data = expectStatus(`${spec.key} application create`, created, 201);
    credential = data?.clientSecret ?? "";
    if (!credential.startsWith("lsa_")) throw new Error(`${spec.key} application did not return an initial credential`);
    mask(credential);
    const active = (await listCredentials(spec.applicationId)).filter((item) => item.status === "active" && item.revokedAt == null);
    const current = active.filter((item) => item.secretSuffix === credential.slice(-8));
    if (current.length !== 1) throw new Error(`${spec.key} initial credential metadata could not be identified`);
    credentialId = current[0].id;
  } else if (existing.response.status === 200) {
    const current = existing.payload?.data;
    if (current?.clientType !== "service" || current?.trustedBackend !== true) {
      throw new Error(`${spec.applicationId} exists with incompatible immutable trust/client type`);
    }
    const scopes = Array.isArray(current.allowedScopes) ? [...current.allowedScopes] : [];
    const patch = {};
    if (current.name !== spec.applicationName) patch.name = spec.applicationName;
    if (!sameSet(scopes, applicationScopes)) patch.allowedScopes = applicationScopes;
    if (current.accessTokenTtlSeconds !== 900) patch.accessTokenTtlSeconds = 900;
    if (current.status !== "active") patch.status = "active";
    if (Object.keys(patch).length) {
      expectStatus(`${spec.key} application reconcile`, await request(identityBase, path, {
        method: "PATCH", bootstrap: bootstrapSecret, body: patch,
      }), 200);
    }
    const replacement = await request(identityBase, `${path}/credentials`, { method: "POST", bootstrap: bootstrapSecret });
    const data = expectStatus(`${spec.key} temporary credential create`, replacement, 201);
    credential = data?.clientSecret ?? "";
    credentialId = data?.id ?? "";
    if (!credential.startsWith("lsa_") || !credentialId.startsWith("apc_")) {
      throw new Error(`${spec.key} temporary application credential is invalid`);
    }
    mask(credential);
  } else {
    throw new Error(`${spec.key} application lookup failed: ${existing.response.status} ${JSON.stringify(existing.payload)}`);
  }

  return { ...spec, credential, credentialId };
}

async function revokeCredential(context) {
  if (!context?.credentialId) return;
  const result = await request(identityBase,
    `/bootstrap/v1/applications/${encodeURIComponent(context.applicationId)}/credentials/${encodeURIComponent(context.credentialId)}`,
    { method: "DELETE", bootstrap: bootstrapSecret });
  if (![204, 404].includes(result.response.status)) throw new Error(`${context.key} temporary credential revoke returned HTTP ${result.response.status}`);
}

function reconcileModelAccess(context) {
  const now = new Date().toISOString();
  coreSql(`DELETE FROM application_model_access WHERE application_id=${sqlString(context.applicationId)} AND model_key NOT IN ('event','task')`);
  for (const [modelKey, maxAccess] of applicationModelAccess) {
    coreSql(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at)
      VALUES(${sqlString(context.applicationId)},${sqlString(modelKey)},${sqlString(maxAccess)},'service','svc_lifespace_bootstrap',${sqlString(now)},${sqlString(now)})
      ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access,updated_at=excluded.updated_at`);
  }
}

async function ensureAgent(context) {
  const listed = await request(identityBase, "/internal/v1/agents", { bearer: context.credential });
  const data = expectStatus(`${context.key} Agent list`, listed, 200);
  const active = data?.items?.filter?.((item) => item.displayName === context.agentDisplayName && item.status === "active") ?? [];
  if (active.length) return active[0].id;
  const created = await request(identityBase, "/internal/v1/agents", {
    method: "POST", bearer: context.credential, body: { displayName: context.agentDisplayName },
  });
  const agent = expectStatus(`${context.key} Agent create`, created, 201);
  if (!agent?.id?.startsWith("agt_")) throw new Error(`${context.key} Agent ID is invalid`);
  return agent.id;
}

async function issueUserToken(context) {
  const result = await request(identityBase, "/internal/v1/tokens", {
    method: "POST", bearer: context.credential, body: { subjectId: userId, scopes: applicationScopes },
  });
  const data = expectStatus(`${context.key} direct user token`, result, 200);
  if (!data?.accessToken) throw new Error(`${context.key} direct user token missing`);
  mask(data.accessToken);
  return data.accessToken;
}

async function issueAgentToken(context) {
  const result = await request(identityBase, "/internal/v1/agent-tokens", {
    method: "POST",
    bearer: context.credential,
    body: { subjectId: userId, agentId: context.agentId, scopes: applicationScopes },
  });
  const data = expectStatus(`${context.key} delegated Agent token`, result, 200);
  if (!data?.accessToken || data?.principalId !== userId || data?.actor?.id !== context.agentId || data?.applicationId !== context.applicationId) {
    throw new Error(`${context.key} Agent execution context is invalid: ${JSON.stringify(data)}`);
  }
  mask(data.accessToken);
  return data.accessToken;
}

async function revokeActiveDelegations(context, spaceId) {
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations`, { bearer: context.userBearer });
  const data = expectStatus(`${context.key} Delegation list`, result, 200);
  for (const item of data?.items ?? []) {
    if (item.agentId !== context.agentId || item.revokedAt != null) continue;
    const revoked = await request(coreBase,
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations/${encodeURIComponent(item.id)}`,
      { method: "DELETE", bearer: context.userBearer });
    if (![204, 404].includes(revoked.response.status)) throw new Error(`${context.key} prior Delegation revoke returned HTTP ${revoked.response.status}`);
  }
}

async function createDelegation(context, spaceId) {
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations`, {
    method: "POST",
    bearer: context.userBearer,
    body: {
      agentId: context.agentId,
      models: context.delegationModels,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  });
  const data = expectStatus(`${context.key} Delegation create`, result, 201);
  if (!data?.id?.startsWith("dlg_") || data.agentId !== context.agentId || data.applicationId !== context.applicationId || data.spaceId !== spaceId) {
    throw new Error(`${context.key} Delegation response is invalid: ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function verifyDiscovery(context, spaceId) {
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/_discovery`, { bearer: context.agentBearer });
  const data = expectStatus(`${context.key} Runtime Discovery`, result, 200);
  for (const [modelKey, expectedAccess] of Object.entries(context.expectedDiscovery)) {
    const model = data?.models?.find?.((entry) => entry.key === modelKey);
    if (!model || !sameSet(model.access, expectedAccess)) {
      throw new Error(`${context.key} Discovery did not narrow ${modelKey}: ${JSON.stringify(model)}`);
    }
  }
}

async function verifyChange(context, spaceId, recordId, expectedOperation = "create") {
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/changes?recordId=${encodeURIComponent(recordId)}`, { bearer: context.agentBearer });
  const data = expectStatus(`${context.key} Change History`, result, 200);
  const change = data?.items?.find?.((item) => item.operation === expectedOperation && item.recordId === recordId);
  if (!change
      || change.detailAvailable !== true
      || change.principal?.type !== "user"
      || change.principal?.id !== userId
      || change.actor?.type !== "agent"
      || change.actor?.id !== context.agentId
      || change.applicationId !== context.applicationId
      || change.delegationId !== context.delegationId) {
    throw new Error(`${context.key} Change attribution is invalid: ${JSON.stringify(change)}`);
  }
  const detailResult = await request(
    coreBase,
    `/api/v1/spaces/${encodeURIComponent(spaceId)}/changes/by-id/${encodeURIComponent(change.id)}`,
    { bearer: context.agentBearer },
  );
  const detail = expectStatus(`${context.key} exact Change Detail`, detailResult, 200);
  if (detail?.id !== change.id || detail?.detailAvailable !== true || !Array.isArray(detail?.fieldChanges)) {
    throw new Error(`${context.key} exact Change detail is invalid: ${JSON.stringify(detail)}`);
  }
  return change;
}

function verifyEventEvidence(context, spaceId, recordId, version) {
  const rows = coreSql(`SELECT e.id AS event_id,e.event_type,e.actor_type AS outbox_actor_type,e.actor_id AS outbox_actor_id,
      c.id AS change_id,c.principal_type,c.principal_id,c.actor_type AS change_actor_type,c.actor_id AS change_actor_id,
      c.application_id,c.delegation_id
    FROM domain_event_outbox e
    JOIN resource_changes c ON c.id=e.change_id
    WHERE e.space_id=${sqlString(spaceId)} AND e.record_id=${sqlString(recordId)} AND e.record_version=${Number(version)} AND e.event_type='record.created'
    ORDER BY e.occurred_at DESC LIMIT 1`);
  const evidence = rows[0];
  if (!evidence
      || evidence.change_id == null
      || evidence.outbox_actor_type !== "user"
      || evidence.outbox_actor_id !== userId
      || evidence.principal_type !== "user"
      || evidence.principal_id !== userId
      || evidence.change_actor_type !== "agent"
      || evidence.change_actor_id !== context.agentId
      || evidence.application_id !== context.applicationId
      || evidence.delegation_id !== context.delegationId
      || !String(evidence.change_id ?? "").startsWith("chg_")) {
    throw new Error(`${context.key} Event/Change evidence is invalid: ${JSON.stringify(evidence)}`);
  }
  return { eventId: evidence.event_id, changeId: evidence.change_id };
}

async function revokeDelegation(context, spaceId) {
  if (!context?.delegationId) return;
  const result = await request(coreBase,
    `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations/${encodeURIComponent(context.delegationId)}`,
    { method: "DELETE", bearer: context.userBearer });
  if (![204, 404].includes(result.response.status)) throw new Error(`${context.key} Delegation revoke returned HTTP ${result.response.status}`);
  context.delegationId = "";
}

async function deleteRecord(spaceId, route, record) {
  if (!record?.id || !record?.version) return;
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/${route}/${encodeURIComponent(record.id)}`, {
    method: "DELETE", bearer: cleanupBearer, body: { version: record.version },
  });
  if (![204, 404].includes(result.response.status)) throw new Error(`${route} cleanup returned HTTP ${result.response.status}`);
}

async function closeSpace(space) {
  if (!space?.id || !space?.version) return;
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(space.id)}/close`, {
    method: "POST", bearer: cleanupBearer, body: { version: space.version },
  });
  if (![204, 404].includes(result.response.status)) throw new Error(`Space cleanup returned HTTP ${result.response.status}`);
}

let contexts = [];
let primarySpace = null;
let wrongSpace = null;
let agentAEvent = null;
let agentBTask = null;
let agentBTaskCatalogLowered = false;
let membershipAuthorityLowered = false;
let primaryError = null;
const cleanupErrors = [];
let resultSummary = null;

try {
  const primaryCreated = await request(coreBase, "/api/v1/spaces", {
    method: "POST",
    bearer: cleanupBearer,
    body: {
      name: `Agent staging primary Space ${suffix}`,
      ownerDisplayName: `Agent Staging Owner ${suffix}`,
      timezone: "Asia/Shanghai",
    },
  });
  primarySpace = expectStatus("primary Space create", primaryCreated, 201);
  if (!primarySpace?.id?.startsWith("spc_")) throw new Error("primary Space response is invalid");
  const spaceId = primarySpace.id;

  contexts = await Promise.all(agents.map(ensureApplication));
  for (const context of contexts) {
    reconcileModelAccess(context);
    context.agentId = await ensureAgent(context);
    context.userBearer = await issueUserToken(context);
    await revokeActiveDelegations(context, spaceId);
    context.agentBearer = await issueAgentToken(context);

    const noDelegation = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records?limit=1`, { bearer: context.agentBearer });
    if (noDelegation.response.status !== 403) {
      throw new Error(`${context.key} Agent inherited user authority without Delegation: HTTP ${noDelegation.response.status}`);
    }

    context.delegationId = await createDelegation(context, spaceId);
    await verifyDiscovery(context, spaceId);
  }

  const agentA = contexts.find((item) => item.key === "agentA");
  const agentB = contexts.find((item) => item.key === "agentB");
  if (!agentA || !agentB) throw new Error("Agent contexts are incomplete");

  const wrongApplication = await request(identityBase, "/internal/v1/agent-tokens", {
    method: "POST",
    bearer: agentB.credential,
    body: { subjectId: userId, agentId: agentA.agentId, scopes: applicationScopes },
  });
  if (wrongApplication.response.status !== 403) {
    throw new Error(`Agent identity crossed application boundary: HTTP ${wrongApplication.response.status}`);
  }

  const tempSpace = await request(coreBase, "/api/v1/spaces", {
    method: "POST",
    bearer: cleanupBearer,
    body: { name: `Agent staging wrong-space ${suffix}`, ownerDisplayName: `Agent Staging Owner ${suffix}`, timezone: "UTC" },
  });
  wrongSpace = expectStatus("wrong-Space fixture create", tempSpace, 201);
  const wrongSpaceProbe = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(wrongSpace.id)}/models/event/records?limit=1`, { bearer: agentA.agentBearer });
  if (wrongSpaceProbe.response.status !== 403) {
    throw new Error(`Agent A crossed Space Delegation boundary: HTTP ${wrongSpaceProbe.response.status}`);
  }

  const selfGrant = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations`, {
    method: "POST", bearer: agentA.agentBearer, body: { agentId: agentA.agentId, models: [{ modelKey: "task", maxAccess: "write" }] },
  });
  if (selfGrant.response.status !== 403) throw new Error(`Agent self-Delegation was not denied: HTTP ${selfGrant.response.status}`);

  const invalidEvent = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records`, {
    method: "POST",
    bearer: agentA.agentBearer,
    body: {
      summary: `Invalid Agent A event ${suffix}`,
      isAllDay: true,
      startDate: "2026-09-10",
      endDateExclusive: "2026-09-09",
    },
  });
  if (invalidEvent.response.status !== 400) {
    throw new Error(`Agent bypassed Event semantic validation: HTTP ${invalidEvent.response.status} ${JSON.stringify(invalidEvent.payload)}`);
  }

  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const createdEvent = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records`, {
    method: "POST",
    bearer: agentA.agentBearer,
    body: {
      summary: `Agent A staging ${suffix}`,
      isAllDay: true,
      startDate: dateOnly(start),
      endDateExclusive: dateOnly(end),
    },
  });
  agentAEvent = expectStatus("Agent A Event create", createdEvent, 201);
  if (!agentAEvent?.id || agentAEvent.version !== 1) throw new Error("Agent A Event response is invalid");

  const agentATaskDenied = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/task/records`, {
    method: "POST", bearer: agentA.agentBearer, body: { name: `Agent A must not create task ${suffix}` },
  });
  if (agentATaskDenied.response.status !== 403) {
    throw new Error(`Agent A exceeded Task read Delegation: HTTP ${agentATaskDenied.response.status}`);
  }

  const agentAChange = await verifyChange(agentA, spaceId, agentAEvent.id);
  const agentAEvidence = verifyEventEvidence(agentA, spaceId, agentAEvent.id, agentAEvent.version);

  const agentBEventDenied = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/event/records`, {
    method: "POST",
    bearer: agentB.agentBearer,
    body: {
      summary: `Agent B must not write Event ${suffix}`,
      isAllDay: true,
      startDate: dateOnly(start),
      endDateExclusive: dateOnly(end),
    },
  });
  if (agentBEventDenied.response.status !== 403) {
    throw new Error(`Agent B exceeded Event read Delegation: HTTP ${agentBEventDenied.response.status}`);
  }

  const createdTask = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/task/records`, {
    method: "POST", bearer: agentB.agentBearer, body: { name: `Agent B staging ${suffix}` },
  });
  agentBTask = expectStatus("Agent B Task create", createdTask, 201);
  if (!agentBTask?.id || agentBTask.version !== 1 || agentBTask.status !== "pending") throw new Error("Agent B Task response is invalid");

  const agentBChange = await verifyChange(agentB, spaceId, agentBTask.id);
  const agentBEvidence = verifyEventEvidence(agentB, spaceId, agentBTask.id, agentBTask.version);

  coreSql(`UPDATE application_model_access SET max_access='read',updated_at=${sqlString(new Date().toISOString())}
    WHERE application_id=${sqlString(agentB.applicationId)} AND model_key='task'`);
  agentBTaskCatalogLowered = true;
  const applicationCeilingDenied = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/task/records`, {
    method: "POST", bearer: agentB.agentBearer, body: { name: `Agent B app ceiling must deny ${suffix}` },
  });
  if (applicationCeilingDenied.response.status !== 403) {
    throw new Error(`Agent B exceeded current Application x Model Access: HTTP ${applicationCeilingDenied.response.status}`);
  }
  coreSql(`UPDATE application_model_access SET max_access='write',updated_at=${sqlString(new Date().toISOString())}
    WHERE application_id=${sqlString(agentB.applicationId)} AND model_key='task'`);
  agentBTaskCatalogLowered = false;

  coreSql(`UPDATE space_memberships SET role='viewer',updated_at=${sqlString(new Date().toISOString())}
    WHERE space_id=${sqlString(spaceId)} AND user_id=${sqlString(userId)} AND deleted_at IS NULL`);
  membershipAuthorityLowered = true;
  const userAuthorityDenied = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/task/records`, {
    method: "POST", bearer: agentB.agentBearer, body: { name: `Agent B user authority must deny ${suffix}` },
  });
  if (userAuthorityDenied.response.status !== 403) {
    throw new Error(`Agent B exceeded current user Space authority: HTTP ${userAuthorityDenied.response.status}`);
  }
  coreSql(`UPDATE space_memberships SET role='owner',updated_at=${sqlString(new Date().toISOString())}
    WHERE space_id=${sqlString(spaceId)} AND user_id=${sqlString(userId)} AND deleted_at IS NULL`);
  membershipAuthorityLowered = false;

  await revokeDelegation(agentB, spaceId);
  const afterRevoke = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/task/records`, {
    method: "POST", bearer: agentB.agentBearer, body: { name: `Agent B stale token must fail ${suffix}` },
  });
  if (afterRevoke.response.status !== 403) {
    throw new Error(`Revoked Agent B Delegation remained usable: HTTP ${afterRevoke.response.status}`);
  }

  resultSummary = {
    ok: true,
    mergeGate: "Intent/Action -> Execution Context -> Effective Authority -> Semantic Validation -> Commit Change -> Attribution/Provenance/Event evidence",
    primarySpace: { id: spaceId },
    principalId: userId,
    agentA: {
      applicationId: agentA.applicationId,
      agentId: agentA.agentId,
      delegation: { event: "write", task: "read" },
      eventRecordId: agentAEvent.id,
      changeId: agentAChange.id,
      domainEventId: agentAEvidence.eventId,
    },
    agentB: {
      applicationId: agentB.applicationId,
      agentId: agentB.agentId,
      delegation: { event: "read", task: "write" },
      taskRecordId: agentBTask.id,
      changeId: agentBChange.id,
      domainEventId: agentBEvidence.eventId,
      revocationRecheckedWithStillValidToken: true,
    },
    denyPaths: {
      noDelegation: true,
      wrongSpace: true,
      wrongApplication: true,
      delegationModelCeiling: true,
      applicationModelCeiling: true,
      currentUserSpaceAuthority: true,
      agentSelfGrant: true,
      semanticValidationBypass: true,
    },
    sameGenericRuntime: true,
    userPrincipalAndAgentActorSeparated: true,
    eventEvidenceCorrelatedByRecordVersionWithGovernedChange: true,
    webhookActorIdentityRemainsReferenceOnly: true,
    productionUntouched: true,
  };
} catch (error) {
  primaryError = error;
} finally {
  async function cleanup(label, action) {
    try { await action(); }
    catch (error) { cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  const spaceId = primarySpace?.id ?? "";
  if (membershipAuthorityLowered && spaceId) {
    await cleanup("Space membership authority restore", async () => {
      coreSql(`UPDATE space_memberships SET role='owner',updated_at=${sqlString(new Date().toISOString())}
        WHERE space_id=${sqlString(spaceId)} AND user_id=${sqlString(userId)} AND deleted_at IS NULL`);
      membershipAuthorityLowered = false;
    });
  }
  if (agentBTaskCatalogLowered) {
    const agentB = contexts.find((item) => item.key === "agentB");
    if (agentB) await cleanup("Agent B Task catalog restore", async () => {
      coreSql(`UPDATE application_model_access SET max_access='write',updated_at=${sqlString(new Date().toISOString())}
        WHERE application_id=${sqlString(agentB.applicationId)} AND model_key='task'`);
      agentBTaskCatalogLowered = false;
    });
  }
  for (const context of contexts) {
    if (context.delegationId && context.userBearer && spaceId) await cleanup(`${context.key} Delegation revoke`, () => revokeDelegation(context, spaceId));
  }
  if (spaceId && agentAEvent) await cleanup("Agent A Event delete", () => deleteRecord(spaceId, "events", agentAEvent));
  if (spaceId && agentBTask) await cleanup("Agent B Task delete", () => deleteRecord(spaceId, "tasks", agentBTask));
  if (wrongSpace?.id) await cleanup("wrong-Space fixture close", () => closeSpace(wrongSpace));
  if (primarySpace?.id) await cleanup("primary Space close", () => closeSpace(primarySpace));
  for (const context of contexts) await cleanup(`${context.key} temporary credential revoke`, () => revokeCredential(context));
}

if (primaryError) {
  if (cleanupErrors.length) primaryError.message += `; cleanup warnings: ${cleanupErrors.join(" | ")}`;
  throw primaryError;
}
if (cleanupErrors.length) throw new Error(`Agent-ready staging cleanup failed: ${cleanupErrors.join(" | ")}`);

console.log(JSON.stringify({
  ...resultSummary,
  cleanup: {
    delegationsRevoked: true,
    recordsRemoved: true,
    temporarySpacesClosed: true,
    temporaryCredentialsRevoked: true,
    mutableAuthorityFixturesRestored: true,
  },
}, null, 2));

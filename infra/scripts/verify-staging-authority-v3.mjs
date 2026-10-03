import process from "node:process";

const identityBase = (process.env.LIFESPACE_IDENTITY_STAGING_URL ?? "https://auth-staging.aisr.online").replace(/\/+$/u, "");
const coreBase = (process.env.LIFESPACE_CORE_STAGING_URL ?? "https://core-staging.aisr.online").replace(/\/+$/u, "");
const applicationSecret = process.env.LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET ?? "";
const userBearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const userId = process.env.LIFESPACE_STAGING_SMOKE_USER_ID ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).replace(/[^0-9A-Za-z_-]/gu, "_");

for (const [name, value] of Object.entries({
  LIFESPACE_STAGING_SMOKE_APPLICATION_SECRET: applicationSecret,
  LIFESPACE_STAGING_USER_BEARER: userBearer,
  LIFESPACE_STAGING_SMOKE_USER_ID: userId,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

async function request(base, path, { method = "GET", bearer, body, delegationId } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
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

async function createAgent(label) {
  const result = await request(identityBase, "/internal/v1/agents", {
    method: "POST",
    bearer: applicationSecret,
    body: { displayName: `Staging ${label} ${runId}` },
  });
  const data = expectStatus(result, 201, `${label} identity creation`);
  if (!data?.id?.startsWith("agt_")) throw new Error(`${label} identity response did not contain agt_* id`);
  return data.id;
}

async function issueAgentToken({ agentId, principalType, principalId }) {
  const body = {
    agentId,
    scopes: ["resources:read", "resources:write"],
    ...(principalType ? { principalType, principalId } : {}),
  };
  const result = await request(identityBase, "/internal/v1/agent-tokens", {
    method: "POST",
    bearer: applicationSecret,
    body,
  });
  const data = expectStatus(result, 200, `Agent execution token for ${agentId}`);
  if (!data?.accessToken) throw new Error(`Agent execution token for ${agentId} omitted accessToken`);
  console.log(`::add-mask::${data.accessToken}`);
  return data.accessToken;
}

async function createTask(bearer, name, delegationId) {
  return request(coreBase, `/api/v1/spaces/${spaceId}/models/task/records`, {
    method: "POST",
    bearer,
    delegationId,
    body: { name },
  });
}

async function firstChange(recordId) {
  const result = await request(
    coreBase,
    `/api/v1/spaces/${spaceId}/changes?recordId=${encodeURIComponent(recordId)}&limit=10`,
    { bearer: userBearer },
  );
  const data = expectStatus(result, 200, `Change History for ${recordId}`);
  const change = data?.items?.[0];
  if (!change) throw new Error(`Change History for ${recordId} returned no items`);
  return change;
}

let agentGrantId = "";
let rootDelegationId = "";
let rootRevoked = false;

try {
  const agentA = await createAgent("Authority Agent A");
  const agentB = await createAgent("Authority Agent B");
  const grantExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  const grant = await request(coreBase, `/api/v1/spaces/${spaceId}/grants`, {
    method: "POST",
    bearer: userBearer,
    body: {
      granteeType: "agent",
      granteeId: agentA,
      resourceType: "model",
      resourceId: "task",
      permission: "write",
      expiresAt: grantExpiry,
    },
  });
  const grantData = expectStatus(grant, 201, "Agent A task Data Grant");
  agentGrantId = grantData?.id ?? "";
  if (!agentGrantId) throw new Error("Agent A task Data Grant omitted id");

  const directAgentA = await issueAgentToken({ agentId: agentA });
  const profileProbe = await request(coreBase, "/api/v1/me", { bearer: directAgentA });
  if (
    profileProbe.response.status !== 403
    || profileProbe.payload?.error?.code !== "FORBIDDEN"
    || !String(profileProbe.payload?.error?.message ?? "").includes("profile:read")
  ) {
    throw new Error(`Direct Agent profile scope boundary was not enforced: HTTP ${profileProbe.response.status} ${JSON.stringify(profileProbe.payload)}`);
  }

  const directCreate = await createTask(directAgentA, `Authority v3 direct Agent ${runId}`);
  const directTask = expectStatus(directCreate, 201, "Direct Agent task create");
  if (!directTask?.id) throw new Error("Direct Agent task create omitted record id");
  const directChange = await firstChange(directTask.id);
  if (
    directChange.principal?.type !== "agent"
    || directChange.principal?.id !== agentA
    || directChange.actor?.type !== "agent"
    || directChange.actor?.id !== agentA
    || directChange.delegationId !== null
  ) {
    throw new Error(`Direct Agent governed Change attribution mismatch: ${JSON.stringify(directChange)}`);
  }

  const rootExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const root = await request(coreBase, `/api/v1/spaces/${spaceId}/agent-delegations`, {
    method: "POST",
    bearer: userBearer,
    body: {
      agentId: agentA,
      scope: { target: { type: "model", id: "task" }, maxAccess: "write" },
      constraints: { expiresAt: rootExpiry, remainingRedelegationDepth: 1 },
    },
  });
  const rootData = expectStatus(root, 201, "User -> Agent A Root Delegation");
  rootDelegationId = rootData?.id ?? "";
  if (!rootDelegationId || rootData?.parentDelegationId !== null || rootData?.constraints?.remainingRedelegationDepth !== 1) {
    throw new Error(`Root Delegation representation mismatch: ${JSON.stringify(rootData)}`);
  }

  const representedA = await issueAgentToken({
    agentId: agentA,
    principalType: "user",
    principalId: userId,
  });
  const childExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const child = await request(coreBase, `/api/v1/spaces/${spaceId}/agent-delegations`, {
    method: "POST",
    bearer: representedA,
    body: {
      agentId: agentB,
      parentDelegationId: rootDelegationId,
      scope: { target: { type: "model", id: "task" }, maxAccess: "write" },
      constraints: { expiresAt: childExpiry, remainingRedelegationDepth: 0 },
    },
  });
  const childData = expectStatus(child, 201, "Agent A -> Agent B Child Delegation");
  const childDelegationId = childData?.id ?? "";
  if (
    !childDelegationId
    || childData?.parentDelegationId !== rootDelegationId
    || childData?.principal?.type !== "user"
    || childData?.principal?.id !== userId
    || childData?.createdBy?.type !== "agent"
    || childData?.createdBy?.id !== agentA
    || childData?.constraints?.remainingRedelegationDepth !== 0
  ) {
    throw new Error(`Child Delegation representation mismatch: ${JSON.stringify(childData)}`);
  }

  const representedB = await issueAgentToken({
    agentId: agentB,
    principalType: "user",
    principalId: userId,
  });
  const delegatedCreate = await createTask(
    representedB,
    `Authority v3 re-delegated Agent ${runId}`,
    childDelegationId,
  );
  const delegatedTask = expectStatus(delegatedCreate, 201, "Agent B re-delegated task create");
  if (!delegatedTask?.id) throw new Error("Agent B re-delegated task create omitted record id");
  const delegatedChange = await firstChange(delegatedTask.id);
  if (
    delegatedChange.principal?.type !== "user"
    || delegatedChange.principal?.id !== userId
    || delegatedChange.actor?.type !== "agent"
    || delegatedChange.actor?.id !== agentB
    || delegatedChange.delegationId !== childDelegationId
  ) {
    throw new Error(`Re-delegated governed Change attribution mismatch: ${JSON.stringify(delegatedChange)}`);
  }

  const revokeRoot = await request(
    coreBase,
    `/api/v1/spaces/${spaceId}/agent-delegations/${encodeURIComponent(rootDelegationId)}`,
    { method: "DELETE", bearer: userBearer },
  );
  expectStatus(revokeRoot, 204, "Root Delegation revoke");
  rootRevoked = true;

  const deniedAfterRootRevoke = await createTask(
    representedB,
    `Must be denied after Root revoke ${runId}`,
    childDelegationId,
  );
  if (deniedAfterRootRevoke.response.status !== 403) {
    throw new Error(`Child Delegation remained usable after Root revoke: HTTP ${deniedAfterRootRevoke.response.status} ${JSON.stringify(deniedAfterRootRevoke.payload)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    scenario: "Agent Principal + bounded re-delegation",
    directAgentProfileScopeDenied: true,
    directAgentAuthority: true,
    directAgentChangeAttribution: true,
    rootDelegationId,
    childDelegationId,
    rootPrincipalPreserved: true,
    childActorAttributed: true,
    ancestorRevocationInvalidatesChild: true,
  }, null, 2));
} finally {
  if (rootDelegationId && !rootRevoked) {
    try {
      await request(
        coreBase,
        `/api/v1/spaces/${spaceId}/agent-delegations/${encodeURIComponent(rootDelegationId)}`,
        { method: "DELETE", bearer: userBearer },
      );
    } catch (error) {
      console.warn(`Root Delegation cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (agentGrantId) {
    try {
      await request(
        coreBase,
        `/api/v1/spaces/${spaceId}/grants/${encodeURIComponent(agentGrantId)}`,
        { method: "DELETE", bearer: userBearer },
      );
    } catch (error) {
      console.warn(`Agent Data Grant cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const profile = JSON.parse(readFileSync(new URL("../aloha-integration-profile.json", import.meta.url), "utf8"));
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

const application = profile.application ?? {};
const agentPolicy = profile.agentIdentity ?? {};
const coreAuthority = profile.coreAuthority ?? {};
const runtimeBoundary = profile.runtimeToolBoundary ?? {};
const applicationId = String(application.stagingId ?? "");
const applicationScopes = application.allowedUserScopes ?? [];
const agentScopes = agentPolicy.m4RequestedScopes ?? [];
const delegatedModels = coreAuthority.m4DelegationModels ?? [];
const modelAccess = coreAuthority.m4ModelAccess ?? {};

function sameSet(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value) => right.includes(value));
}

function assertProfile() {
  if (profile.profileVersion !== 2 || profile.trackingIssue !== 162 || profile.status !== "candidate") {
    throw new Error("ALOHA M4 integration profile version/tracking state drifted");
  }
  if (!applicationId || application.clientType !== "web" || application.trustedBackend !== true || application.accessTokenTtlSeconds !== 900) {
    throw new Error("ALOHA M4 staging Application profile is invalid");
  }
  if (!sameSet(applicationScopes, ["profile:read", "resources:read"]) || applicationScopes.includes("resources:write")) {
    throw new Error("ALOHA M4 Application scope ceiling must be exactly profile:read + resources:read");
  }
  if (!sameSet(agentScopes, ["resources:read"])) {
    throw new Error("ALOHA M4 delegated Agent token must request resources:read only");
  }
  if (JSON.stringify(modelAccess) !== JSON.stringify({ task: "read" })) {
    throw new Error("ALOHA M4 Application x Model Access must be Task read only");
  }
  if (coreAuthority.m4DelegationRequired !== true
      || delegatedModels.length !== 1
      || delegatedModels[0]?.modelKey !== "task"
      || delegatedModels[0]?.maxAccess !== "read") {
    throw new Error("ALOHA M4 Delegation must be explicit Task read only");
  }
  if (coreAuthority.m4RuntimeDiscovery !== "authoritative" || coreAuthority.m4WriteAuthority !== false) {
    throw new Error("ALOHA M4 must keep Runtime Discovery authoritative and write authority disabled");
  }
  if (runtimeBoundary.delegatedTokenConsumer !== "aloha-agent-control"
      || runtimeBoundary.n8nReceivesLifeSpaceCredential !== false
      || runtimeBoundary.n8nReceivesDelegatedAgentToken !== false) {
    throw new Error("ALOHA M4 Runtime Tool credential boundary drifted");
  }
}

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

async function request(base, path, { method = "GET", bootstrap = "", bearer = "", body } = {}) {
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

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Identity returned a malformed JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

function tokenScopes(claims) {
  return typeof claims.scope === "string" ? claims.scope.split(/\s+/u).filter(Boolean) : [];
}

function audienceIncludes(claims, expected) {
  return claims.aud === expected || (Array.isArray(claims.aud) && claims.aud.includes(expected));
}

async function listCredentials() {
  const result = await request(
    identityBase,
    `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`,
    { bootstrap: bootstrapSecret },
  );
  const data = expectStatus("ALOHA M4 credential list", result, 200);
  if (!Array.isArray(data)) throw new Error("ALOHA M4 credential list is invalid");
  return data;
}

async function ensureApplication() {
  const path = `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`;
  let existing = await request(identityBase, path, { bootstrap: bootstrapSecret });
  let credential = "";
  let credentialId = "";
  let created = false;

  if (existing.response.status === 404) {
    const result = await request(identityBase, "/bootstrap/v1/applications", {
      method: "POST",
      bootstrap: bootstrapSecret,
      body: {
        id: applicationId,
        name: "ALOHA Assistant staging",
        clientType: application.clientType,
        allowedScopes: applicationScopes,
        trustedBackend: true,
        accessTokenTtlSeconds: application.accessTokenTtlSeconds,
      },
    });
    const data = expectStatus("ALOHA M4 Application create", result, 201);
    credential = data?.clientSecret ?? "";
    if (!credential.startsWith("lsa_")) throw new Error("ALOHA M4 Application did not return an initial credential");
    mask(credential);
    const active = (await listCredentials()).filter((item) => item.status === "active" && item.revokedAt == null);
    const current = active.filter((item) => item.secretSuffix === credential.slice(-8));
    if (current.length !== 1) throw new Error("ALOHA M4 initial credential metadata could not be identified");
    credentialId = current[0].id;
    created = true;
    existing = await request(identityBase, path, { bootstrap: bootstrapSecret });
  } else if (existing.response.status === 200) {
    const current = existing.payload?.data;
    if (current?.clientType !== application.clientType || current?.trustedBackend !== true) {
      throw new Error(
        `ALOHA staging Application ${applicationId} has incompatible immutable classification: `
        + `${JSON.stringify({ clientType: current?.clientType, trustedBackend: current?.trustedBackend })}`,
      );
    }
    const patch = {};
    if (current.name !== "ALOHA Assistant staging") patch.name = "ALOHA Assistant staging";
    if (!sameSet(current.allowedScopes, applicationScopes)) patch.allowedScopes = applicationScopes;
    if (current.accessTokenTtlSeconds !== application.accessTokenTtlSeconds) patch.accessTokenTtlSeconds = application.accessTokenTtlSeconds;
    if (current.status !== "active") patch.status = "active";
    if (Object.keys(patch).length) {
      expectStatus("ALOHA M4 Application reconcile", await request(identityBase, path, {
        method: "PATCH", bootstrap: bootstrapSecret, body: patch,
      }), 200);
    }

    const replacement = await request(identityBase, `${path}/credentials`, {
      method: "POST", bootstrap: bootstrapSecret,
    });
    const data = expectStatus("ALOHA M4 temporary credential create", replacement, 201);
    credential = data?.clientSecret ?? "";
    credentialId = data?.id ?? "";
    if (!credential.startsWith("lsa_") || !credentialId.startsWith("apc_")) {
      throw new Error("ALOHA M4 temporary credential is invalid");
    }
    mask(credential);
    existing = await request(identityBase, path, { bootstrap: bootstrapSecret });
  } else {
    throw new Error(`ALOHA M4 Application lookup failed: ${existing.response.status} ${JSON.stringify(existing.payload)}`);
  }

  const current = existing.payload?.data;
  if (existing.response.status !== 200
      || current?.id !== applicationId
      || current?.clientType !== "web"
      || current?.trustedBackend !== true
      || current?.accessTokenTtlSeconds !== 900
      || current?.status !== "active"
      || !sameSet(current?.allowedScopes, applicationScopes)) {
    throw new Error(`ALOHA M4 Application does not match profile: ${JSON.stringify(current)}`);
  }

  return { credential, credentialId, created };
}

async function revokeCredential(credentialId) {
  if (!credentialId) return;
  const result = await request(
    identityBase,
    `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE", bootstrap: bootstrapSecret },
  );
  if (![204, 404].includes(result.response.status)) {
    throw new Error(`ALOHA M4 temporary credential revoke returned HTTP ${result.response.status}`);
  }
}

async function ensureAgent(credential) {
  const listed = await request(identityBase, "/internal/v1/agents", { bearer: credential });
  const data = expectStatus("ALOHA M4 Agent list", listed, 200);
  const active = data?.items?.filter?.((item) => item.status === "active") ?? [];
  if (active.length > 1) throw new Error(`ALOHA M4 requires one active Agent; found ${active.length}`);
  if (active.length === 1) return active[0].id;

  const created = await request(identityBase, "/internal/v1/agents", {
    method: "POST",
    bearer: credential,
    body: { displayName: agentPolicy.displayName },
  });
  const agent = expectStatus("ALOHA M4 Agent create", created, 201);
  if (!agent?.id?.startsWith("agt_")) throw new Error("ALOHA M4 Agent ID is invalid");
  return agent.id;
}

function reconcileModelAccess() {
  const now = new Date().toISOString();
  coreSql(`DELETE FROM application_model_access WHERE application_id=${sqlString(applicationId)}`);
  for (const [modelKey, maxAccess] of Object.entries(modelAccess)) {
    coreSql(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(
      ${sqlString(applicationId)},${sqlString(modelKey)},${sqlString(maxAccess)},
      'service','svc_lifespace_bootstrap',${sqlString(now)},${sqlString(now)}
    )`);
  }
  const rows = coreSql(`SELECT model_key,max_access FROM application_model_access
    WHERE application_id=${sqlString(applicationId)} ORDER BY model_key`);
  if (rows.length !== 1 || rows[0]?.model_key !== "task" || rows[0]?.max_access !== "read") {
    throw new Error(`ALOHA M4 Application x Model Access did not converge to Task read only: ${JSON.stringify(rows)}`);
  }
}

async function issueDirectUserToken(credential) {
  const result = await request(identityBase, "/internal/v1/tokens", {
    method: "POST",
    bearer: credential,
    body: { subjectId: userId, scopes: applicationScopes },
  });
  const data = expectStatus("ALOHA M4 direct user token", result, 200);
  const token = data?.accessToken ?? "";
  if (!token) throw new Error("ALOHA M4 direct user token is missing");
  mask(token);
  const claims = decodeJwtPayload(token);
  if (claims.sub !== userId
      || claims.azp !== applicationId
      || claims.principal_type !== "user"
      || claims.actor_type
      || !sameSet(tokenScopes(claims), applicationScopes)) {
    throw new Error(`ALOHA M4 direct user identity tuple is invalid: ${JSON.stringify(claims)}`);
  }
  return token;
}

async function issueAgentToken(credential, agentId) {
  const result = await request(identityBase, "/internal/v1/agent-tokens", {
    method: "POST",
    bearer: credential,
    body: { subjectId: userId, agentId, scopes: agentScopes },
  });
  const data = expectStatus("ALOHA M4 delegated Agent token", result, 200);
  const token = data?.accessToken ?? "";
  if (!token
      || data?.principalId !== userId
      || data?.actor?.id !== agentId
      || data?.applicationId !== applicationId) {
    throw new Error(`ALOHA M4 delegated execution context is invalid: ${JSON.stringify(data)}`);
  }
  mask(token);
  const claims = decodeJwtPayload(token);
  if (claims.sub !== userId
      || claims.azp !== applicationId
      || claims.principal_type !== "user"
      || claims.actor_type !== "agent"
      || claims.actor_id !== agentId
      || claims.purpose !== agentPolicy.executionTokenPurpose
      || !sameSet(tokenScopes(claims), ["resources:read"])
      || tokenScopes(claims).includes("resources:write")
      || !audienceIncludes(claims, "lifespace-core")) {
    throw new Error(`ALOHA M4 delegated JWT claims are invalid: ${JSON.stringify(claims)}`);
  }
  return token;
}

async function createReadDelegation(userBearer, agentId, spaceId) {
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations`, {
    method: "POST",
    bearer: userBearer,
    body: {
      agentId,
      models: delegatedModels,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    },
  });
  const data = expectStatus("ALOHA M4 Task-read Delegation create", result, 201);
  if (!data?.id?.startsWith("dlg_")
      || data.agentId !== agentId
      || data.applicationId !== applicationId
      || data.spaceId !== spaceId
      || JSON.stringify(data.models) !== JSON.stringify(delegatedModels)) {
    throw new Error(`ALOHA M4 Delegation response is invalid: ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function revokeDelegation(userBearer, spaceId, delegationId) {
  if (!delegationId) return;
  const result = await request(
    coreBase,
    `/api/v1/spaces/${encodeURIComponent(spaceId)}/agent-delegations/${encodeURIComponent(delegationId)}`,
    { method: "DELETE", bearer: userBearer },
  );
  if (![204, 404].includes(result.response.status)) {
    throw new Error(`ALOHA M4 Delegation revoke returned HTTP ${result.response.status}`);
  }
}

function taskPath(spaceId, taskId = "") {
  const collection = `/api/v1/spaces/${encodeURIComponent(spaceId)}/models/task/records`;
  return taskId ? `${collection}/${encodeURIComponent(taskId)}` : collection;
}

async function closeSpace(spaceId, version) {
  if (!spaceId || !version) return;
  const result = await request(coreBase, `/api/v1/spaces/${encodeURIComponent(spaceId)}/close`, {
    method: "POST",
    bearer: cleanupBearer,
    body: { version },
  });
  if (![204, 404].includes(result.response.status)) {
    throw new Error(`ALOHA M4 temporary Space close returned HTTP ${result.response.status}`);
  }
}

assertProfile();

let credentialId = "";
let userBearer = "";
let agentBearer = "";
let agentId = "";
let delegationId = "";
let spaceId = "";
let spaceVersion = 0;
let taskId = "";
let taskVersion = 0;
let verificationSucceeded = false;
const cleanupErrors = [];

try {
  const app = await ensureApplication();
  credentialId = app.credentialId;
  reconcileModelAccess();
  agentId = await ensureAgent(app.credential);
  userBearer = await issueDirectUserToken(app.credential);
  agentBearer = await issueAgentToken(app.credential, agentId);

  const createdSpace = await request(coreBase, "/api/v1/spaces", {
    method: "POST",
    bearer: cleanupBearer,
    body: {
      kind: "personal",
      name: `ALOHA M4 read authority ${suffix}`,
      ownerDisplayName: `ALOHA M4 Owner ${suffix}`,
      timezone: "UTC",
    },
  });
  const space = expectStatus("ALOHA M4 temporary Space create", createdSpace, 201);
  spaceId = space?.id ?? "";
  spaceVersion = space?.version ?? 0;
  if (!spaceId.startsWith("spc_") || spaceVersion !== 1) throw new Error("ALOHA M4 temporary Space response is invalid");

  const marker = `ALOHA M4 read task ${suffix}`;
  const createdTask = await request(coreBase, taskPath(spaceId), {
    method: "POST",
    bearer: cleanupBearer,
    body: { name: marker },
  });
  const task = expectStatus("ALOHA M4 Task fixture create", createdTask, 201);
  taskId = task?.id ?? "";
  taskVersion = task?.version ?? 0;
  if (!taskId.startsWith("rec_") || taskVersion !== 1) throw new Error("ALOHA M4 Task fixture is invalid");

  const beforeDelegation = await request(coreBase, taskPath(spaceId, taskId), { bearer: agentBearer });
  if (beforeDelegation.response.status !== 403) {
    throw new Error(`ALOHA Agent inherited Task authority without Delegation: HTTP ${beforeDelegation.response.status}`);
  }

  delegationId = await createReadDelegation(userBearer, agentId, spaceId);

  const discoveryResult = await request(
    coreBase,
    `/api/v1/spaces/${encodeURIComponent(spaceId)}/_discovery`,
    { bearer: agentBearer },
  );
  const discovery = expectStatus("ALOHA M4 Runtime Discovery", discoveryResult, 200);
  const taskModel = discovery?.models?.find?.((entry) => entry.key === "task");
  const eventModel = discovery?.models?.find?.((entry) => entry.key === "event");
  if (!taskModel || !sameSet(taskModel.access, ["read"]) || eventModel) {
    throw new Error(`ALOHA M4 Discovery must expose Task read only: ${JSON.stringify(discovery?.models)}`);
  }

  const queryResult = await request(coreBase, `${taskPath(spaceId)}/query`, {
    method: "POST",
    bearer: agentBearer,
    body: { search: { text: marker }, page: { limit: 10 } },
  });
  const query = expectStatus("ALOHA M4 Task Canonical Query", queryResult, 200);
  if (!Array.isArray(query?.items) || !query.items.some((item) => item.id === taskId && item.name === marker)) {
    throw new Error(`ALOHA M4 Task query did not return the authorized fixture: ${JSON.stringify(query)}`);
  }

  const readResult = await request(coreBase, taskPath(spaceId, taskId), { bearer: agentBearer });
  const read = expectStatus("ALOHA M4 Task read", readResult, 200);
  if (read?.id !== taskId || read?.name !== marker || read?.version !== taskVersion) {
    throw new Error(`ALOHA M4 Task read returned unexpected data: ${JSON.stringify(read)}`);
  }

  const createDenied = await request(coreBase, taskPath(spaceId), {
    method: "POST",
    bearer: agentBearer,
    body: { name: `ALOHA M4 write must fail ${suffix}` },
  });
  if (createDenied.response.status !== 403) {
    throw new Error(`ALOHA M4 Task create was not denied: HTTP ${createDenied.response.status}`);
  }

  const actionDenied = await request(coreBase, `${taskPath(spaceId, taskId)}/actions/complete`, {
    method: "POST",
    bearer: agentBearer,
    body: { version: taskVersion },
  });
  if (actionDenied.response.status !== 403) {
    throw new Error(`ALOHA M4 Task.complete was not denied: HTTP ${actionDenied.response.status}`);
  }

  await revokeDelegation(userBearer, spaceId, delegationId);
  delegationId = "";

  const afterRevoke = await request(coreBase, taskPath(spaceId, taskId), { bearer: agentBearer });
  if (afterRevoke.response.status !== 403) {
    throw new Error(`Revoked ALOHA M4 Delegation remained usable with a still-valid token: HTTP ${afterRevoke.response.status}`);
  }

  const discoveryAfterRevoke = await request(
    coreBase,
    `/api/v1/spaces/${encodeURIComponent(spaceId)}/_discovery`,
    { bearer: agentBearer },
  );
  if (discoveryAfterRevoke.response.status === 200) {
    const models = discoveryAfterRevoke.payload?.data?.models ?? [];
    if (models.some((entry) => entry.key === "task")) {
      throw new Error("Revoked ALOHA M4 Delegation remained visible in Runtime Discovery");
    }
  } else if (discoveryAfterRevoke.response.status !== 403) {
    throw new Error(`ALOHA M4 post-revocation Discovery returned unexpected HTTP ${discoveryAfterRevoke.response.status}`);
  }

  verificationSucceeded = true;
  console.log(JSON.stringify({
    ok: true,
    profileVersion: profile.profileVersion,
    application: {
      id: applicationId,
      clientType: application.clientType,
      trustedBackend: application.trustedBackend,
      allowedUserScopes: applicationScopes,
      modelAccess,
    },
    executionContext: {
      principalType: "user",
      principalId: userId,
      actorType: "agent",
      agentId,
      applicationId,
      delegatedScopes: agentScopes,
      delegation: delegatedModels,
    },
    goldenFlow: {
      noDelegationDenied: true,
      runtimeDiscoveryTaskReadOnly: true,
      canonicalTaskQuery: true,
      taskGet: true,
      taskCreateDenied: true,
      taskCompleteDenied: true,
      revocationRecheckedWithStillValidToken: true,
    },
    credentialBoundary: {
      applicationCredentialServerOnly: true,
      delegatedAgentTokenConsumer: runtimeBoundary.delegatedTokenConsumer,
      n8nReceivesLifeSpaceCredential: runtimeBoundary.n8nReceivesLifeSpaceCredential,
      n8nReceivesDelegatedAgentToken: runtimeBoundary.n8nReceivesDelegatedAgentToken,
    },
    productionUntouched: true,
  }, null, 2));
} finally {
  async function cleanup(label, action) {
    try { await action(); }
    catch (error) { cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  if (delegationId && userBearer && spaceId) {
    await cleanup("ALOHA M4 Delegation revoke", () => revokeDelegation(userBearer, spaceId, delegationId));
  }
  if (taskId && taskVersion && spaceId) {
    await cleanup("ALOHA M4 Task fixture delete", async () => {
      const result = await request(coreBase, taskPath(spaceId, taskId), {
        method: "DELETE",
        bearer: cleanupBearer,
        body: { version: taskVersion },
      });
      if (![204, 404].includes(result.response.status)) throw new Error(`HTTP ${result.response.status}`);
    });
  }
  if (spaceId && spaceVersion) {
    await cleanup("ALOHA M4 temporary Space close", () => closeSpace(spaceId, spaceVersion));
  }
  if (credentialId) {
    await cleanup("ALOHA M4 temporary credential revoke", () => revokeCredential(credentialId));
  }
}

if (cleanupErrors.length) {
  if (verificationSucceeded) throw new Error(`ALOHA M4 cleanup failed: ${cleanupErrors.join(" | ")}`);
  console.error(`ALOHA M4 cleanup warnings: ${cleanupErrors.join(" | ")}`);
}

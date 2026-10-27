import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertProductionServiceUrl } from "./production-expectations.mjs";

const PRODUCTION_IDENTITY_DATABASE_NAME = "lifespace-identity";
const PLATFORM_ADMIN_BOOTSTRAP_PATH = "/bootstrap/v1/platform-administrators";

export function extractD1Rows(payload) {
  const entries = Array.isArray(payload?.result)
    ? payload.result
    : (Array.isArray(payload) ? payload : [payload]);
  return entries.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
}

export function resolveUniqueDatabaseId(databases, databaseName = PRODUCTION_IDENTITY_DATABASE_NAME) {
  const matches = (Array.isArray(databases) ? databases : []).filter((entry) => entry?.name === databaseName && typeof entry?.uuid === "string" && entry.uuid);
  if (matches.length !== 1) throw new Error(`Expected exactly one production D1 database named ${databaseName}; found ${matches.length}`);
  return matches[0].uuid;
}

export function selectUniqueAccessBackedUserId(rows) {
  const ids = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => typeof row?.user_id === "string" ? row.user_id.trim() : "")
    .filter((id) => /^usr_[0-9A-Za-z_-]+$/u.test(id)))];
  if (ids.length !== 1) {
    throw new Error(`Expected exactly one active production user already backed by a verified Cloudflare Access principal; found ${ids.length}. Configure LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID explicitly before retrying.`);
  }
  return ids[0];
}

function mask(value) {
  if (typeof value === "string" && value) console.log(`::add-mask::${value}`);
}

function persist(githubEnv, name, value) {
  if (!value || /[\r\n]/u.test(value)) throw new Error(`${name} is invalid`);
  mask(value);
  appendFileSync(githubEnv, `${name}=${value}\n`, "utf8");
}

async function jsonRequest(base, path, { method = "GET", bootstrapSecret = "" } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(bootstrapSecret ? { "x-bootstrap-secret": bootstrapSecret } : {}),
    },
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = raw; }
  }
  return { response, payload };
}

async function cloudflareRequest(accountId, apiToken, path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new Error(`Cloudflare production Identity D1 request failed: ${method} ${path} HTTP ${response.status}`);
  }
  return payload;
}

async function queryAccessBackedUsers(accountId, apiToken) {
  const databasesPayload = await cloudflareRequest(accountId, apiToken, "/d1/database?per_page=1000");
  const databaseId = resolveUniqueDatabaseId(databasesPayload.result);
  const sql = [
    "SELECT DISTINCT u.id AS user_id",
    "FROM users u",
    "INNER JOIN access_principals ap ON ap.user_id = u.id",
    "WHERE u.status = 'active' AND ap.status = 'active' AND ap.subject IS NOT NULL",
    "ORDER BY u.id",
    "LIMIT 2",
  ].join(" ");
  const queryPayload = await cloudflareRequest(
    accountId,
    apiToken,
    `/d1/database/${encodeURIComponent(databaseId)}/query`,
    { method: "POST", body: { sql } },
  );
  return extractD1Rows(queryPayload);
}

async function main() {
  const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
  const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
  const cloudflareAccountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const cloudflareApiToken = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  const suppliedUserId = (process.env.LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID ?? "").trim();
  const recoverPlatformAdmin = process.env.LIFESPACE_PRODUCTION_CONSOLE_RECOVER_PLATFORM_ADMIN === "1";
  const githubEnv = (process.env.GITHUB_ENV ?? "").trim();

  assertProductionServiceUrl(identityBase, "identity");
  if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
  if (!githubEnv) throw new Error("GITHUB_ENV is required");
  mask(bootstrapSecret);

  if (suppliedUserId && !/^usr_[0-9A-Za-z_-]+$/u.test(suppliedUserId)) {
    throw new Error("LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID must use a usr_* identifier");
  }

  const assignments = await jsonRequest(identityBase, PLATFORM_ADMIN_BOOTSTRAP_PATH, { bootstrapSecret });
  if (assignments.response.status !== 200 || !Array.isArray(assignments.payload?.data)) {
    throw new Error(`Could not list production platform administrators: HTTP ${assignments.response.status}`);
  }
  const active = assignments.payload.data.filter((entry) => entry?.status === "active" && entry?.userStatus === "active" && /^usr_[0-9A-Za-z_-]+$/u.test(entry?.userId ?? ""));
  if (suppliedUserId) {
    const isActive = active.some((entry) => entry.userId === suppliedUserId);
    if (!isActive && !recoverPlatformAdmin) {
      throw new Error("Selected production platform administrator is not active. Explicitly select recover_platform_admin for a deliberate Bootstrap assignment.");
    }
    if (!isActive) {
      const assigned = await jsonRequest(identityBase, `${PLATFORM_ADMIN_BOOTSTRAP_PATH}/${encodeURIComponent(suppliedUserId)}`, {
        method: "PUT", bootstrapSecret,
      });
      if (assigned.response.status !== 200 || assigned.payload?.data?.userId !== suppliedUserId || assigned.payload?.data?.status !== "active") {
        throw new Error(`Explicit production platform administrator recovery failed: HTTP ${assigned.response.status}`);
      }
    }
    persist(githubEnv, "LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID", suppliedUserId);
    console.log(JSON.stringify({ ok: true, source: "explicit-environment", assignmentCreated: !isActive, assignmentRequested: !isActive && recoverPlatformAdmin }));
    return;
  }
  if (active.length > 1) {
    throw new Error(`Production has ${active.length} active platform administrators; configure LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID explicitly to choose the Console operator.`);
  }
  if (active.length === 1) {
    persist(githubEnv, "LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID", active[0].userId);
    console.log(JSON.stringify({ ok: true, source: "existing-assignment", assignmentCreated: false }));
    return;
  }
  // Zero active assignments can be first-use or an intentional administrator
  // revocation. Never interpret zero as permission to restore on every deploy.
  if (!recoverPlatformAdmin) {
    throw new Error("No active production platform administrator. First-use or break-glass assignment requires explicit recover_platform_admin confirmation.");
  }

  if (!cloudflareAccountId || !cloudflareApiToken) {
    throw new Error("Cloudflare account/token are required to resolve the real production Identity D1 database for first-rollout administrator bootstrap");
  }
  mask(cloudflareApiToken);

  // Break-glass first-rollout resolution deliberately uses only Identity's already-verified
  // Access-principal -> global-user mapping. It never selects by email/display metadata,
  // Access subject, Space membership, or application-specific external identifiers.
  const userId = selectUniqueAccessBackedUserId(await queryAccessBackedUsers(cloudflareAccountId, cloudflareApiToken));
  const assigned = await jsonRequest(identityBase, `${PLATFORM_ADMIN_BOOTSTRAP_PATH}/${encodeURIComponent(userId)}`, {
    method: "PUT",
    bootstrapSecret,
  });
  if (assigned.response.status !== 200 || assigned.payload?.data?.userId !== userId || assigned.payload?.data?.status !== "active") {
    throw new Error(`Production platform administrator break-glass assignment failed: HTTP ${assigned.response.status}`);
  }

  persist(githubEnv, "LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID", userId);
  console.log(JSON.stringify({
    ok: true,
    source: "unique-verified-access-principal",
    assignmentCreated: true,
    databaseResolvedByName: true,
    emailUsedAsAuthority: false,
    accessSubjectUsedAsAuthority: false,
    candidateCount: 1,
  }));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await main();

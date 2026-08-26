import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { assertProductionServiceUrl } from "./production-expectations.mjs";

const IDENTITY_DIR = new URL("../../apps/identity/", import.meta.url);

export function extractD1Rows(payload) {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.flatMap((entry) => Array.isArray(entry?.results) ? entry.results : []);
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

function queryAccessBackedUsers() {
  const sql = [
    "SELECT DISTINCT u.id AS user_id",
    "FROM users u",
    "INNER JOIN access_principals ap ON ap.user_id = u.id",
    "WHERE u.status = 'active' AND ap.status = 'active'",
    "ORDER BY u.id",
    "LIMIT 2",
  ].join(" ");
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "production", "--json", `--command=${sql}`],
    { cwd: IDENTITY_DIR, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.some((entry) => entry?.success === false)) {
    throw new Error("Production Identity D1 Access-principal lookup failed");
  }
  return extractD1Rows(parsed);
}

async function main() {
  const identityBase = (process.env.LIFESPACE_IDENTITY_PRODUCTION_URL ?? "https://auth.aisr.online").replace(/\/+$/u, "");
  const bootstrapSecret = process.env.LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET ?? "";
  const suppliedUserId = (process.env.LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID ?? "").trim();
  const githubEnv = (process.env.GITHUB_ENV ?? "").trim();

  assertProductionServiceUrl(identityBase, "identity");
  if (bootstrapSecret.length < 32) throw new Error("LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET must contain at least 32 characters");
  if (!githubEnv) throw new Error("GITHUB_ENV is required");
  mask(bootstrapSecret);

  if (suppliedUserId) {
    if (!/^usr_[0-9A-Za-z_-]+$/u.test(suppliedUserId)) throw new Error("LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID must use a usr_* identifier");
    persist(githubEnv, "LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID", suppliedUserId);
    console.log(JSON.stringify({ ok: true, source: "explicit-environment", assignmentCreated: false }));
    return;
  }

  const assignments = await jsonRequest(identityBase, "/bootstrap/v1/platform-administrators", { bootstrapSecret });
  if (assignments.response.status !== 200 || !Array.isArray(assignments.payload?.data)) {
    throw new Error(`Could not list production platform administrators: HTTP ${assignments.response.status}`);
  }
  const active = assignments.payload.data.filter((entry) => entry?.status === "active" && entry?.userStatus === "active" && /^usr_[0-9A-Za-z_-]+$/u.test(entry?.userId ?? ""));
  if (active.length > 1) {
    throw new Error(`Production has ${active.length} active platform administrators; configure LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID explicitly to choose the Console operator.`);
  }
  if (active.length === 1) {
    persist(githubEnv, "LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID", active[0].userId);
    console.log(JSON.stringify({ ok: true, source: "existing-assignment", assignmentCreated: false }));
    return;
  }

  // Break-glass first-rollout resolution deliberately uses only Identity's already-verified
  // Access-principal -> global-user mapping. It never inspects email_snapshot, display_name,
  // Access subject, Space membership, or application-specific external identifiers.
  const userId = selectUniqueAccessBackedUserId(queryAccessBackedUsers());
  const assigned = await jsonRequest(identityBase, `/bootstrap/v1/platform-administrators/${encodeURIComponent(userId)}`, {
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
    emailUsedAsAuthority: false,
    accessSubjectUsedAsAuthority: false,
    candidateCount: 1,
  }));
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) await main();

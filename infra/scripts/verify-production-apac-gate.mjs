import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const APAC_GATE_WORKFLOW_NAME = "APAC performance gate";
export const APAC_GATE_WORKFLOW_PATH = ".github/workflows/apac-performance-gate.yml";
export const DEFAULT_MAX_GATE_AGE_MS = 24 * 60 * 60 * 1000;

export function parseApacGateRunId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9][0-9]*$/u.test(text)) {
    throw new Error(`APAC gate run ID must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return text;
}

function parseTimestamp(value, label) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) throw new Error(`APAC gate ${label} is missing or invalid: ${JSON.stringify(value)}`);
  return timestamp;
}

export function assertProductionApacGateRun(run, {
  repository,
  candidateSha,
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_GATE_AGE_MS,
} = {}) {
  if (!run || typeof run !== "object") throw new Error("APAC gate response is not an object");
  if (!repository) throw new Error("repository is required");
  if (!/^[a-f0-9]{40}$/u.test(candidateSha ?? "")) throw new Error(`candidateSha must be a full Git SHA, got ${JSON.stringify(candidateSha)}`);
  if (!Number.isFinite(nowMs)) throw new Error("nowMs must be finite");
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error("maxAgeMs must be positive");

  if (run.name !== APAC_GATE_WORKFLOW_NAME) {
    throw new Error(`APAC gate workflow name mismatch: expected ${APAC_GATE_WORKFLOW_NAME}, got ${JSON.stringify(run.name)}`);
  }
  if (run.path !== APAC_GATE_WORKFLOW_PATH) {
    throw new Error(`APAC gate workflow path mismatch: expected ${APAC_GATE_WORKFLOW_PATH}, got ${JSON.stringify(run.path)}`);
  }
  if (run.event !== "workflow_dispatch") {
    throw new Error(`APAC gate must be explicitly dispatched, got event ${JSON.stringify(run.event)}`);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(`APAC gate did not complete successfully: status=${JSON.stringify(run.status)} conclusion=${JSON.stringify(run.conclusion)}`);
  }
  if (run.head_branch !== "main") {
    throw new Error(`APAC gate must target main, got ${JSON.stringify(run.head_branch)}`);
  }
  if (run.head_sha !== candidateSha) {
    throw new Error(`APAC gate candidate mismatch: production=${candidateSha}, gate=${JSON.stringify(run.head_sha)}`);
  }
  if (run.repository?.full_name !== repository || (run.head_repository?.full_name && run.head_repository.full_name !== repository)) {
    throw new Error(`APAC gate repository mismatch: expected ${repository}, got repository=${JSON.stringify(run.repository?.full_name)} headRepository=${JSON.stringify(run.head_repository?.full_name)}`);
  }

  const startedAtMs = parseTimestamp(run.run_started_at ?? run.created_at, "run_started_at");
  const ageMs = nowMs - startedAtMs;
  if (ageMs < -5 * 60 * 1000) throw new Error(`APAC gate run starts in the future by ${Math.round(-ageMs / 1000)} seconds`);
  if (ageMs > maxAgeMs) {
    throw new Error(`APAC gate is stale: age ${Math.round(ageMs / 60000)} minutes exceeds ${Math.round(maxAgeMs / 60000)} minutes`);
  }

  return Object.freeze({
    runId: Number(run.id),
    runNumber: Number(run.run_number),
    runAttempt: Number(run.run_attempt ?? 1),
    headSha: run.head_sha,
    headBranch: run.head_branch,
    runStartedAt: run.run_started_at ?? run.created_at,
    workflow: run.name,
  });
}

export async function fetchGitHubWorkflowRun({ repository, runId, token, fetchImpl = fetch }) {
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const normalizedRunId = parseApacGateRunId(runId);
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs/${normalizedRunId}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "lifespace-production-apac-gate",
    },
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`GitHub APAC gate lookup returned non-JSON HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
  }
  if (!response.ok) {
    throw new Error(`GitHub APAC gate lookup failed HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const candidateSha = process.env.GITHUB_SHA ?? "";
  const runId = process.env.LIFESPACE_APAC_GATE_RUN_ID ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const run = await fetchGitHubWorkflowRun({ repository, runId, token });
  const evidence = assertProductionApacGateRun(run, { repository, candidateSha });
  console.log(JSON.stringify({ ok: true, ...evidence, maxAgeHours: DEFAULT_MAX_GATE_AGE_MS / 3600000 }, null, 2));
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();

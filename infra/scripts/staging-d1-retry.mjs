import { execFileSync } from "node:child_process";

const RETRYABLE_D1_PATTERNS = [
  /\bcode[:\s"']*7429\b/iu,
  /D1 DB storage operation exceeded timeout which caused object to be reset/iu,
];

function errorText(error) {
  const parts = [
    error instanceof Error ? error.message : "",
    error?.stdout,
    error?.stderr,
  ];
  return parts
    .filter((part) => part !== undefined && part !== null)
    .map((part) => Buffer.isBuffer(part) ? part.toString("utf8") : String(part))
    .join("\n");
}

export function isRetryableStagingD1Error(error) {
  const text = errorText(error);
  return RETRYABLE_D1_PATTERNS.some((pattern) => pattern.test(text));
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function executeStagingD1Sql({
  cwd,
  sql,
  env = process.env,
  attempts = 3,
  delayMs = 1000,
  exec = execFileSync,
  sleep = defaultSleep,
} = {}) {
  if (!cwd) throw new Error("cwd is required for staging D1 execution");
  if (!sql) throw new Error("sql is required for staging D1 execution");
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("attempts must be a positive integer");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("delayMs must be non-negative");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const output = exec(
        "pnpm",
        ["exec", "wrangler", "d1", "execute", "DB", "--remote", "--env", "staging", "--json", `--command=${sql}`],
        { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      const parsed = JSON.parse(output);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      if (entries.some((entry) => entry?.success === false)) {
        throw new Error(`Staging D1 command returned an unsuccessful result: ${output}`);
      }
      return entries;
    } catch (error) {
      lastError = error;
      if (!isRetryableStagingD1Error(error) || attempt === attempts) throw error;
      const waitMs = delayMs * attempt;
      console.warn(`[staging-d1] transient D1 timeout on attempt ${attempt}/${attempts}; retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}

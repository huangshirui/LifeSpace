import { setTimeout as delay } from "node:timers/promises";

export async function requestWithStagingAuthConvergence({
  request,
  method = "GET",
  attempts = 6,
  delayMs = 1_000,
  sleep = delay,
  label = "staging authenticated request",
}) {
  if (typeof request !== "function") throw new TypeError("request must be a function");
  if (!Number.isInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer");

  let last = null;
  const normalizedMethod = String(method).toUpperCase();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await request();
    const status = last?.response?.status ?? last?.status;
    const retryable =
      status === 401
      || (normalizedMethod === "GET" && Number.isInteger(status) && status >= 500);

    if (!retryable || attempt === attempts) return last;

    const waitMs = attempt * delayMs;
    console.warn(
      `${label} returned HTTP ${status}; retrying in ${waitMs}ms (${attempt}/${attempts})`,
    );
    await sleep(waitMs);
  }

  return last;
}

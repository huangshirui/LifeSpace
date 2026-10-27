import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  "utf8",
);

test("Cron dispatches durable Eventing before any potentially slow external or R2 work", () => {
  const jobs = /const jobs = \[([\s\S]*?)\] as const;/u.exec(source)?.[1] ?? "";
  assert.ok(jobs, "Scheduled job list must be explicit and reviewed");
  const names = [...jobs.matchAll(/\["([^"]+)",\s*([a-zA-Z]+)\]/gu)].map((match) => ({
    name: match[1],
    handler: match[2],
  }));
  assert.deepEqual(names, [
    { name: "eventing", handler: "dispatchPendingDomainEvents" },
    { name: "external-models", handler: "reconcileExternalModels" },
    { name: "recurrence", handler: "rollRecurrenceWindow" },
    { name: "file-cleanup", handler: "cleanupFileUploads" },
  ]);
  assert.match(source, /for \(const \[name, work\] of jobs\)/u);
  assert.match(source, /await work\(env\)/u, "Do not silently skip scheduled work");
  assert.match(source, /failures\.push\(error\)/u, "Keep failed jobs isolated; do not skip later jobs");
  assert.match(source, /if \(failures\.length === 1\) throw failures\[0\]/u);
  assert.match(source, /if \(failures\.length\) throw new AggregateError/u);
});

test("Cron logs evidence of trigger lateness versus in-handler job duration", () => {
  assert.match(source, /startedAt - controller\.scheduledTime/u);
  assert.match(source, /scheduledAtMs: controller\.scheduledTime/u);
  assert.match(source, /startDelayMs > 60_000/u);
  assert.match(source, /job\.durationMs > 15_000/u);
  assert.match(source, /durationMs: Date\.now\(\) - beganAt/u);
  assert.match(source, /console\.warn\("Core scheduled jobs latency"/u);
});

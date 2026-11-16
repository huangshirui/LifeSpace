import configuration from "../scheduled-jobs.json";

export type ScheduledJob = "eventing" | "external-models" | "recurrence" | "file-cleanup";
type Intervals = Record<ScheduledJob, number>;
const schedules: Record<"local" | "staging" | "production", Intervals> = configuration;

/** Deployment-owned per-environment configuration; no D1 state or cache. */
export function scheduledJobDue(job: ScheduledJob, environment: string | undefined, scheduledTime: number): boolean {
  const target = environment === "staging" || environment === "production" ? environment : "local";
  const interval = schedules[target][job];
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 1440) {
    throw new Error(`Invalid scheduled interval for ${target}/${job}`);
  }
  // Use the trigger's scheduled UTC minute, not the delayed invocation's wall clock.
  // Missed ticks are reconciled on the next due sweep by existing durable due state.
  return Math.floor(scheduledTime / 60_000) % interval === 0;
}

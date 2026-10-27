import { rollRecurrenceWindow } from "./recurrence-runtime";
import { reconcileExternalModels } from "./external-model";
import { createApp } from "./app";
import { dispatchPendingDomainEvents, processWebhookDeliveryQueue, type WebhookDeliveryQueueMessage } from "./eventing";
import type { Bindings } from "./env";
import { cleanupFileUploads } from "./file-routes";

const app = createApp();

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<WebhookDeliveryQueueMessage>, env: Bindings): Promise<void> {
    await processWebhookDeliveryQueue(batch, env);
  },
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    const startedAt = Date.now();
    const startDelayMs = Math.max(0, startedAt - controller.scheduledTime);
    const failures: unknown[] = [];
    const durations: Array<{ job: string; durationMs: number; status: "ok" | "failed" }> = [];

    // Event delivery is latency-sensitive: do not make it wait for external
    // Adapter requests, recurrence reconciliation or slow R2 cleanup.
    // Later jobs retain independent error isolation and their original order.
    const jobs = [
      ["eventing", dispatchPendingDomainEvents],
      ["external-models", reconcileExternalModels],
      ["recurrence", rollRecurrenceWindow],
      ["file-cleanup", cleanupFileUploads],
    ] as const;
    for (const [name, work] of jobs) {
      const beganAt = Date.now();
      try {
        await work(env);
        durations.push({ job: name, durationMs: Date.now() - beganAt, status: "ok" });
      } catch (error) {
        failures.push(error);
        durations.push({ job: name, durationMs: Date.now() - beganAt, status: "failed" });
      }
    }

    // One compact warning only when this tick is late, slow or failed.
    // These durations distinguish delayed Cron invocation from in-handler
    // head-of-line blocking without exposing request payloads or secrets.
    if (startDelayMs > 60_000 || durations.some((job) => job.durationMs > 15_000) || failures.length) {
      console.warn("Core scheduled jobs latency", {
        scheduledAtMs: controller.scheduledTime,
        startDelayMs,
        totalDurationMs: Date.now() - startedAt,
        durations,
      });
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Scheduled jobs failed");
  },
};

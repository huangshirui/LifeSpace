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
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    const failures: unknown[] = [];
    for (const work of [reconcileExternalModels, rollRecurrenceWindow, cleanupFileUploads, dispatchPendingDomainEvents]) {
      try { await work(env); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, "Scheduled jobs failed");
  },
};

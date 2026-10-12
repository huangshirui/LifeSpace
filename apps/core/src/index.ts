import { rollRecurrenceWindow } from "./recurrence-runtime";
import { createApp } from "./app";
import { dispatchPendingDomainEvents, processWebhookDeliveryQueue, type WebhookDeliveryQueueMessage } from "./eventing";
import type { Bindings } from "./env";

const app = createApp();

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<WebhookDeliveryQueueMessage>, env: Bindings): Promise<void> {
    await processWebhookDeliveryQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    try {
      await rollRecurrenceWindow(env);
    } finally {
      // A failed recurrence dependency must not starve the existing outbox.
      // Preserve the rejection so the scheduler still reports failed rolling.
      const dispatched = await dispatchPendingDomainEvents(env);
      if (dispatched > 0) console.log("Domain events dispatched", { dispatched });
    }
  },
};

import { reconcileExternalModels } from "./external-model";
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
    await reconcileExternalModels(env);
    const dispatched = await dispatchPendingDomainEvents(env);
    if (dispatched > 0) console.log("Domain events dispatched", { dispatched });
  },
};

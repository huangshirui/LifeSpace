import { createApp } from "./app";
import { cleanupExpiredCreationDraftJobs } from "./creation-draft-cleanup";
import { dispatchPendingDomainEvents, processWebhookDeliveryQueue, type WebhookDeliveryQueueMessage } from "./eventing";
import {
  defaultRegistryCreationProvider,
  processRegistryCreationDraftQueue,
  type RegistryCreationDraftQueueMessage,
} from "./registry-creation-draft-jobs";
import type { Bindings } from "./env";

const app = createApp();
type CoreQueueMessage = RegistryCreationDraftQueueMessage | WebhookDeliveryQueueMessage;

function isWebhookDelivery(message: CoreQueueMessage): message is WebhookDeliveryQueueMessage {
  return "kind" in message
    && (message.kind === "webhook-delivery" || message.kind === "webhook-delivery-batch");
}

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<CoreQueueMessage>, env: Bindings): Promise<void> {
    if (batch.messages.every((message) => isWebhookDelivery(message.body))) {
      await processWebhookDeliveryQueue(batch as MessageBatch<WebhookDeliveryQueueMessage>, env);
      return;
    }
    await processRegistryCreationDraftQueue(
      batch as MessageBatch<RegistryCreationDraftQueueMessage>,
      env,
      { now: () => new Date(), createProvider: defaultRegistryCreationProvider },
    );
  },
  async scheduled(controller: ScheduledController, env: Bindings): Promise<void> {
    const dispatched = await dispatchPendingDomainEvents(env);
    if (dispatched > 0) console.log("Domain events dispatched", { dispatched });
    if (new Date(controller.scheduledTime).getUTCMinutes() === 0) {
      const result = await cleanupExpiredCreationDraftJobs(env);
      if (result.deleted > 0) console.log("Expired creation draft jobs deleted", result);
    }
  },
};

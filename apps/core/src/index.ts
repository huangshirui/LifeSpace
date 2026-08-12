import { createApp } from "./app";
import { cleanupExpiredCreationDraftJobs } from "./creation-draft-cleanup";
import {
  defaultRegistryCreationProvider,
  processRegistryCreationDraftQueue,
  type RegistryCreationDraftQueueMessage,
} from "./registry-creation-draft-jobs";
import type { Bindings } from "./env";

const app = createApp();

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<RegistryCreationDraftQueueMessage>, env: Bindings): Promise<void> {
    await processRegistryCreationDraftQueue(batch, env, { now: () => new Date(), createProvider: defaultRegistryCreationProvider });
  },
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    const result = await cleanupExpiredCreationDraftJobs(env);
    if (result.deleted > 0) console.log("Expired creation draft jobs deleted", result);
  },
};

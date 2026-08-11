import { createApp } from "./app";
import { cleanupExpiredCreationDraftJobs } from "./creation-draft-cleanup";
import { defaultCreationProvider, processCreationDraftQueue, type CreationDraftQueueMessage } from "./creation-draft-jobs";
import type { Bindings } from "./env";

const app = createApp();

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<CreationDraftQueueMessage>, env: Bindings): Promise<void> {
    await processCreationDraftQueue(batch, env, { now: () => new Date(), createProvider: defaultCreationProvider });
  },
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    const result = await cleanupExpiredCreationDraftJobs(env);
    if (result.deleted > 0) console.log("Expired creation draft jobs deleted", result);
  },
};

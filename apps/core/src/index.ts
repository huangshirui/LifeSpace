import { createApp } from "./app";
import { cleanupExpiredCreationDraftJobs } from "./creation-draft-cleanup";
import { defaultCreationProvider, processCreationDraftQueue, type CreationDraftQueueMessage } from "./creation-draft-jobs";
import type { Bindings } from "./env";

const app = createApp();

const worker = {
  fetch: app.fetch.bind(app),
  request: app.request.bind(app),
  async queue(batch: MessageBatch<CreationDraftQueueMessage>, env: Bindings): Promise<void> {
    await processCreationDraftQueue(batch, env, { now: () => new Date(), createProvider: defaultCreationProvider });
  },
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    const result = await cleanupExpiredCreationDraftJobs(env);
    if (result.deleted > 0) console.log("Expired creation draft jobs deleted", result);
  },
};

export { createApp } from "./app";
export type { Bindings } from "./env";
export default worker;

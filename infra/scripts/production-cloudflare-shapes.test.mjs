import assert from "node:assert/strict";
import test from "node:test";
import { queueAttachmentSnapshot } from "./production-cloudflare-shapes.mjs";

test("accepts Queue attachments exposed by List Queues", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [{ type: "worker", script_name: "lifespace-core", consumer_id: "consumer-1" }],
    producers: [{ type: "worker", script: "lifespace-core" }],
  }, []);
  assert.equal(snapshot.consumerAttached, true);
  assert.equal(snapshot.producerAttached, true);
});

test("accepts a consumer exposed only by the dedicated consumer endpoint", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [],
    producers: [{ type: "worker", script: "lifespace-core" }],
  }, [{ type: "worker", script_name: "lifespace-core", consumer_id: "consumer-2" }]);
  assert.equal(snapshot.consumerAttached, true);
  assert.equal(snapshot.producerAttached, true);
});

test("does not accept another Worker as the production Queue attachment", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [{ type: "worker", script_name: "another-worker" }],
    producers: [{ type: "worker", script: "another-worker" }],
  }, []);
  assert.equal(snapshot.consumerAttached, false);
  assert.equal(snapshot.producerAttached, false);
});

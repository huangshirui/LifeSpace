import assert from "node:assert/strict";
import test from "node:test";
import { queueAttachmentSnapshot } from "./production-cloudflare-shapes.mjs";

test("accepts Queue attachments exposed with Wrangler current script field", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [{ type: "worker", script: "lifespace-core", consumer_id: "consumer-1" }],
    producers: [{ type: "worker", script: "lifespace-core" }],
  }, []);
  assert.equal(snapshot.consumerAttached, true);
  assert.equal(snapshot.producerAttached, true);
  assert.equal(snapshot.observed.consumers[0].workerName, "lifespace-core");
});

test("accepts service-backed Queue consumer references used by Wrangler", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [],
    producers: [{ type: "worker", script: "lifespace-core" }],
  }, [{ type: "worker", service: "lifespace-core", environment: "production", consumer_id: "consumer-2" }]);
  assert.equal(snapshot.consumerAttached, true);
  assert.equal(snapshot.producerAttached, true);
  assert.equal(snapshot.observed.consumers[0].workerName, "lifespace-core");
});

test("keeps script_name compatibility with the public Queue API schema", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [{ type: "worker", script_name: "lifespace-core", consumer_id: "consumer-3" }],
    producers: [{ type: "worker", script: "lifespace-core" }],
  }, []);
  assert.equal(snapshot.consumerAttached, true);
  assert.equal(snapshot.producerAttached, true);
});

test("does not accept another Worker as the production Queue attachment", () => {
  const snapshot = queueAttachmentSnapshot({
    consumers: [{ type: "worker", script: "another-worker" }],
    producers: [{ type: "worker", script: "another-worker" }],
  }, []);
  assert.equal(snapshot.consumerAttached, false);
  assert.equal(snapshot.producerAttached, false);
});

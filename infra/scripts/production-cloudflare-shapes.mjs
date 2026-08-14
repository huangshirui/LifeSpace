function consumerWorkerName(consumer) {
  return consumer?.script ?? consumer?.service ?? consumer?.script_name ?? null;
}

export function queueAttachmentSnapshot(queue, endpointConsumers, workerName = "lifespace-core") {
  const listedConsumers = Array.isArray(queue?.consumers) ? queue.consumers : [];
  const directConsumers = Array.isArray(endpointConsumers) ? endpointConsumers : [];
  const consumers = [...listedConsumers, ...directConsumers];
  const producers = Array.isArray(queue?.producers) ? queue.producers : [];

  return {
    consumerAttached: consumers.some((consumer) =>
      consumer?.type === "worker" && consumerWorkerName(consumer) === workerName),
    producerAttached: producers.some((producer) =>
      producer?.type === "worker" && producer?.script === workerName),
    observed: {
      consumers: consumers.map((consumer) => ({
        type: consumer?.type ?? null,
        workerName: consumerWorkerName(consumer),
        script: consumer?.script ?? null,
        service: consumer?.service ?? null,
        scriptName: consumer?.script_name ?? null,
        environment: consumer?.environment ?? null,
        consumerId: consumer?.consumer_id ?? null,
      })),
      producers: producers.map((producer) => ({
        type: producer?.type ?? null,
        script: producer?.script ?? null,
        bucketName: producer?.bucket_name ?? null,
      })),
    },
  };
}

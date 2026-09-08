export const SERVICE_READ_TARGETS = Object.freeze({ p50Ms: 220, p90Ms: 500 });

const DEFAULT_SAMPLE_COUNT = 15;
const DEFAULT_WARMUP_COUNT = 3;
const DEFAULT_MUTATION_SAMPLE_COUNT = 8;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 50).toFixed(1)),
    p90Ms: Number(percentile(values, 90).toFixed(1)),
    p99Ms: Number(percentile(values, 99).toFixed(1)),
    minMs: Number(Math.min(...values).toFixed(1)),
    maxMs: Number(Math.max(...values).toFixed(1)),
  };
}

function targetMet(metric) {
  return metric.p50Ms <= SERVICE_READ_TARGETS.p50Ms && metric.p90Ms <= SERVICE_READ_TARGETS.p90Ms;
}

export async function runStagingServicePerformanceBenchmark({
  coreBaseUrl,
  bearer,
  spaceId,
  benchmarkProfile,
  source,
  fetchImpl = fetch,
  requestAdapter,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  warmupCount = DEFAULT_WARMUP_COUNT,
  mutationSampleCount = DEFAULT_MUTATION_SAMPLE_COUNT,
}) {
  const baseUrl = coreBaseUrl.replace(/\/+$/u, "");
  for (const [name, value] of Object.entries({ coreBaseUrl: baseUrl, bearer, spaceId, benchmarkProfile, source })) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error("sampleCount must be a positive integer");
  if (!Number.isInteger(warmupCount) || warmupCount < 0) throw new Error("warmupCount must be a non-negative integer");
  if (!Number.isInteger(mutationSampleCount) || mutationSampleCount < 1) throw new Error("mutationSampleCount must be a positive integer");
  if (requestAdapter !== undefined && typeof requestAdapter !== "function") throw new Error("requestAdapter must be a function");

  const acceptanceEligible = benchmarkProfile === "apac";
  const marker = `service-perf-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const cleanup = [];

  async function directRequest(path, { method = "GET", body } = {}) {
    const started = performance.now();
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const elapsedMs = performance.now() - started;
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`);
      }
    }
    return { status: response.status, payload, elapsedMs };
  }

  async function request(path, options = {}) {
    const result = requestAdapter
      ? await requestAdapter(path, options)
      : await directRequest(path, options);
    if (!result || !Number.isInteger(result.status) || typeof result.elapsedMs !== "number") {
      throw new Error(`Service benchmark request adapter returned an invalid result for ${options.method ?? "GET"} ${path}`);
    }
    return result;
  }

  async function expectData(path, options = {}, expectedStatus = 200) {
    const result = await request(path, options);
    if (result.status !== expectedStatus) {
      throw new Error(`${options.method ?? "GET"} ${path}: expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.payload)}`);
    }
    return { data: result.payload?.data, elapsedMs: result.elapsedMs };
  }

  async function deleteRecord(record) {
    const result = await request(`/api/v1/spaces/${spaceId}/models/task/records/${record.id}`, { method: "DELETE", body: { version: record.version } });
    if (result.status !== 204 && result.status !== 404) {
      console.warn(`Service performance cleanup tasks/${record.id} failed with ${result.status}: ${JSON.stringify(result.payload)}`);
    }
  }

  async function createTask(name) {
    const created = await expectData(`/api/v1/spaces/${spaceId}/models/task/records`, {
      method: "POST",
      body: { name },
    }, 201);
    const cleanupEntry = { id: created.data.id, version: created.data.version };
    cleanup.push(cleanupEntry);
    return { ...created, cleanupEntry };
  }

  async function measure(operation) {
    for (let index = 0; index < warmupCount; index += 1) await operation();
    const values = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const result = await operation();
      values.push(result.elapsedMs);
    }
    return summarize(values);
  }

  try {
    const getSeed = await createTask(`Service performance GET ${marker}`);
    const patchSeed = await createTask(`Service performance PATCH ${marker}`);
    const actionSeed = await createTask(`Service performance Action ${marker}`);

    const reads = {
      taskGet: await measure(() => expectData(`/api/v1/spaces/${spaceId}/models/task/records/${getSeed.data.id}`)),
      taskList10: await measure(() => expectData(`/api/v1/spaces/${spaceId}/models/task/records?limit=10`)),
    };

    const createSamples = [];
    for (let index = 0; index < mutationSampleCount; index += 1) {
      const created = await createTask(`Service performance Create ${marker} ${index}`);
      createSamples.push(created.elapsedMs);
    }

    let patchVersion = patchSeed.data.version;
    const patchSamples = [];
    for (let index = 0; index < mutationSampleCount; index += 1) {
      const patched = await expectData(`/api/v1/spaces/${spaceId}/models/task/records/${patchSeed.data.id}`, {
        method: "PATCH",
        body: { version: patchVersion, name: `Service performance PATCH ${marker} ${index}` },
      });
      patchVersion = patched.data.version;
      patchSeed.cleanupEntry.version = patchVersion;
      patchSamples.push(patched.elapsedMs);
    }

    let actionVersion = actionSeed.data.version;
    const actionSamples = [];
    for (let index = 0; index < mutationSampleCount; index += 1) {
      const action = index % 2 === 0 ? "complete" : "reopen";
      const changed = await expectData(`/api/v1/spaces/${spaceId}/models/task/records/${actionSeed.data.id}/actions/${action}`, {
        method: "POST",
        body: { version: actionVersion },
      });
      actionVersion = changed.data.version;
      actionSeed.cleanupEntry.version = actionVersion;
      actionSamples.push(changed.elapsedMs);
    }

    const readTargetsMet = Object.fromEntries(Object.entries(reads).map(([key, metric]) => [key, targetMet(metric)]));
    const allReadTargetsMet = Object.values(readTargetsMet).every(Boolean);

    return {
      ok: true,
      credentialMode: "opaque_service_api_token",
      benchmarkProfile,
      acceptanceEligible,
      source,
      marker,
      targets: SERVICE_READ_TARGETS,
      reads,
      readTargetsMet,
      allReadTargetsMet,
      mutations: {
        taskCreate: summarize(createSamples),
        taskPatch: summarize(patchSamples),
        taskWorkflow: summarize(actionSamples),
      },
      note: acceptanceEligible
        ? "Service API Token read timings are acceptance-eligible and use the same Phase-3 common-read envelope; mutation timings are recorded explicitly for #198 convergence."
        : "Diagnostic only: absolute Service API Token timings are not acceptance-eligible outside the controlled APAC probe.",
    };
  } finally {
    for (const record of cleanup.reverse()) await deleteRecord(record);
  }
}

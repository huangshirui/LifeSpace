export const STAGING_READ_TARGETS = Object.freeze({ p50Ms: 220, p90Ms: 500 });

const DEFAULT_SAMPLE_COUNT = 15;
const DEFAULT_WARMUP_COUNT = 3;

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
  return metric.p50Ms <= STAGING_READ_TARGETS.p50Ms && metric.p90Ms <= STAGING_READ_TARGETS.p90Ms;
}

export async function runStagingPerformanceBenchmark({
  coreBaseUrl,
  bearer,
  spaceId,
  personId,
  benchmarkProfile,
  source,
  fetchImpl = fetch,
  requestAdapter,
  sampleCount = DEFAULT_SAMPLE_COUNT,
  warmupCount = DEFAULT_WARMUP_COUNT,
}) {
  const baseUrl = coreBaseUrl.replace(/\/+$/u, "");
  for (const [name, value] of Object.entries({ coreBaseUrl: baseUrl, bearer, spaceId, personId, benchmarkProfile, source })) {
    if (!value) throw new Error(`${name} is required`);
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 1) throw new Error("sampleCount must be a positive integer");
  if (!Number.isInteger(warmupCount) || warmupCount < 0) throw new Error("warmupCount must be a non-negative integer");
  if (requestAdapter !== undefined && typeof requestAdapter !== "function") throw new Error("requestAdapter must be a function");

  const acceptanceEligible = benchmarkProfile === "apac";
  const marker = `perf-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
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
      throw new Error(`Benchmark request adapter returned an invalid result for ${options.method ?? "GET"} ${path}`);
    }
    return result;
  }

  async function expectData(path, options, expectedStatus = 200) {
    const result = await request(path, options);
    if (result.status !== expectedStatus) {
      throw new Error(`${options?.method ?? "GET"} ${path}: expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.payload)}`);
    }
    return { data: result.payload?.data, elapsedMs: result.elapsedMs };
  }

  async function deleteRecord(modelKey, id, version) {
    const result = await request(`/api/v1/spaces/${spaceId}/models/${modelKey}/records/${id}`, { method: "DELETE", body: { version } });
    if (result.status !== 204 && result.status !== 404) {
      console.warn(`Performance cleanup ${modelKey}/${id} failed with ${result.status}: ${JSON.stringify(result.payload)}`);
    }
  }

  async function measure(label, operation) {
    for (let index = 0; index < warmupCount; index += 1) await operation();
    const values = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const result = await operation();
      values.push(result.elapsedMs);
    }
    return [label, summarize(values)];
  }

  try {
    const tasks = [];
    for (let index = 0; index < 10; index += 1) {
      const created = await expectData(`/api/v1/spaces/${spaceId}/models/task/records`, {
        method: "POST",
        body: { name: `Performance task ${marker} ${index}`, assigneePersonIds: index === 0 ? [personId] : [] },
      }, 201);
      tasks.push(created.data);
      cleanup.push({ modelKey: "task", id: created.data.id, version: created.data.version });
    }

    const eventStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const eventEnd = new Date(eventStart.getTime() + 45 * 60 * 1000);
    const event = await expectData(`/api/v1/spaces/${spaceId}/models/event/records`, {
      method: "POST",
      body: {
        summary: `Performance event ${marker}`,
        isAllDay: false,
        startAt: eventStart.toISOString(),
        endAt: eventEnd.toISOString(),
        startTimezone: "UTC",
        endTimezone: "UTC",
        attendeePersonIds: [personId],
      },
    }, 201);
    cleanup.push({ modelKey: "event", id: event.data.id, version: event.data.version });

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const day = await expectData(`/api/v1/spaces/${spaceId}/models/day_record/records`, {
      method: "POST",
      body: { name: `Performance day ${marker}`, kind: "elapsed", anchorDate: yesterday, subjectPersonId: personId },
    }, 201);
    cleanup.push({ modelKey: "day_record", id: day.data.id, version: day.data.version });

    const wish = await expectData(`/api/v1/spaces/${spaceId}/models/wish/records`, {
      method: "POST",
      body: { ownerPersonId: personId, title: `Performance wish ${marker}` },
    }, 201);
    cleanup.push({ modelKey: "wish", id: wish.data.id, version: wish.data.version });

    const eventRangeStart = encodeURIComponent(new Date(eventStart.getTime() - 60_000).toISOString());
    const eventRangeEnd = encodeURIComponent(new Date(eventEnd.getTime() + 60_000).toISOString());

    const entries = [];
    entries.push(await measure("taskGet", () => expectData(`/api/v1/spaces/${spaceId}/models/task/records/${tasks[0].id}`)));
    entries.push(await measure("taskList10", () => expectData(`/api/v1/spaces/${spaceId}/models/task/records?limit=10`)));
    entries.push(await measure("eventWindow", () => expectData(`/api/v1/spaces/${spaceId}/models/event/records?rangeStart=${eventRangeStart}&rangeEnd=${eventRangeEnd}&limit=20`)));
    entries.push(await measure("dayRecordList", () => expectData(`/api/v1/spaces/${spaceId}/models/day_record/records?sort=effectiveDate:asc&limit=20`)));
    entries.push(await measure("wishList", () => expectData(`/api/v1/spaces/${spaceId}/models/wish/records?limit=20`)));
    const reads = Object.fromEntries(entries);

    let patchVersion = tasks[1].version;
    const patchSamples = [];
    for (let index = 0; index < 8; index += 1) {
      const patched = await expectData(`/api/v1/spaces/${spaceId}/models/task/records/${tasks[1].id}`, {
        method: "PATCH",
        body: { version: patchVersion, name: `Performance task ${marker} patch ${index}` },
      });
      patchVersion = patched.data.version;
      patchSamples.push(patched.elapsedMs);
    }
    cleanup.find((item) => item.id === tasks[1].id).version = patchVersion;

    let actionVersion = tasks[2].version;
    const actionSamples = [];
    for (let index = 0; index < 8; index += 1) {
      const action = index % 2 === 0 ? "complete" : "reopen";
      const changed = await expectData(`/api/v1/spaces/${spaceId}/models/task/records/${tasks[2].id}/actions/${action}`, {
        method: "POST",
        body: { version: actionVersion },
      });
      actionVersion = changed.data.version;
      actionSamples.push(changed.elapsedMs);
    }
    cleanup.find((item) => item.id === tasks[2].id).version = actionVersion;

    const readTargetsMet = Object.fromEntries(Object.entries(reads).map(([key, metric]) => [key, targetMet(metric)]));
    const allReadTargetsMet = Object.values(readTargetsMet).every(Boolean);

    return {
      ok: true,
      benchmarkProfile,
      acceptanceEligible,
      source,
      marker,
      targets: STAGING_READ_TARGETS,
      reads,
      readTargetsMet,
      allReadTargetsMet,
      mutations: {
        taskPatch: summarize(patchSamples),
        taskWorkflow: summarize(actionSamples),
      },
      note: acceptanceEligible
        ? "Absolute read targets are eligible for Phase-3 acceptance; D1 round-trip budgets remain independently enforced in Core integration tests."
        : "Diagnostic only: absolute HTTP timings may include long-distance runner-to-edge and Worker-to-D1 latency and must not accept or reject Phase 3. D1 round-trip budgets are enforced separately in Core integration tests.",
    };
  } finally {
    for (const record of cleanup.reverse()) await deleteRecord(record.modelKey, record.id, record.version);
  }
}

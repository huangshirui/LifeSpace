import process from "node:process";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const bearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const secondaryBearer = process.env.LIFESPACE_STAGING_CLAIMANT_USER_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const spaceTimezone = process.env.LIFESPACE_STAGING_SPACE_TIMEZONE ?? "UTC";

for (const [name, value] of Object.entries({
  LIFESPACE_CORE_STAGING_URL: coreBaseUrl,
  LIFESPACE_STAGING_USER_BEARER: bearer,
  LIFESPACE_STAGING_CLAIMANT_USER_BEARER: secondaryBearer,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

function localDate(timeZone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

async function request(path, { method = "GET", body, bearer: requestBearer = bearer } = {}) {
  const response = await fetch(`${coreBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${requestBearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); }
    catch { throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`); }
  }
  return { status: response.status, payload };
}

async function expectData(path, options, expectedStatus = 200) {
  const result = await request(path, options);
  if (result.status !== expectedStatus) {
    throw new Error(`${options?.method ?? "GET"} ${path}: expected ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

async function deleteRecord(modelKey, id, version) {
  const result = await request(`/api/v1/spaces/${spaceId}/models/${modelKey}/records/${id}`, { method: "DELETE", body: { version } });
  if (result.status !== 204 && result.status !== 404) console.warn(`Cleanup ${modelKey}/${id} failed with ${result.status}: ${JSON.stringify(result.payload)}`);
}

const marker = `staging-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const cleanup = [];
const today = localDate(spaceTimezone);

try {
  const task = await expectData(`/api/v1/spaces/${spaceId}/models/task/records`, {
    method: "POST", body: { name: `Staging task ${marker}`, assigneePersonIds: [personId] },
  }, 201);
  cleanup.push({ modelKey: "task", id: task.id, version: task.version });
  if (task.status !== "pending" || task.version !== 1) throw new Error(`Task default/runtime mismatch: ${JSON.stringify(task)}`);
  const completed = await expectData(`/api/v1/spaces/${spaceId}/models/task/records/${task.id}/actions/complete`, { method: "POST", body: { version: task.version } });
  cleanup.at(-1).version = completed.version;
  if (completed.status !== "completed" || !completed.completedAt) throw new Error(`Task complete Workflow mismatch: ${JSON.stringify(completed)}`);
  const reopened = await expectData(`/api/v1/spaces/${spaceId}/models/task/records/${task.id}/actions/reopen`, { method: "POST", body: { version: completed.version } });
  cleanup.at(-1).version = reopened.version;
  if (reopened.status !== "pending" || reopened.completedAt !== null) throw new Error(`Task reopen Workflow mismatch: ${JSON.stringify(reopened)}`);

  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  const event = await expectData(`/api/v1/spaces/${spaceId}/models/event/records`, {
    method: "POST",
    body: {
      summary: `Staging event ${marker}`,
      location: { name: `Staging synthetic venue ${marker}`, coordinates: { latitude: 0, longitude: 0 } },
      when: {
        kind: "instant",
        start: start.toISOString(),
        endExclusive: end.toISOString(),
      },
      attendeePersonIds: [personId],
    },
  }, 201);
  cleanup.push({ modelKey: "event", id: event.id, version: event.version });
  if (event.status !== "active"
      || event.when?.kind !== "instant"
      || event.when?.start !== start.toISOString()
      || event.when?.endExclusive !== end.toISOString()
      || event.location?.name !== `Staging synthetic venue ${marker}`
      || event.location?.coordinates?.latitude !== 0
      || event.location?.coordinates?.longitude !== 0) {
    throw new Error(`Event TemporalRange/default mismatch: ${JSON.stringify(event)}`);
  }
  const events = await expectData(`/api/v1/spaces/${spaceId}/models/event/records/query`, {
    method: "POST",
    body: {
      filter: {
        field: "when",
        op: "overlaps",
        value: {
          kind: "instant",
          start: new Date(start.getTime() - 60_000).toISOString(),
          endExclusive: new Date(end.getTime() + 60_000).toISOString(),
        },
      },
      page: { limit: 20 },
    },
  });
  if (!Array.isArray(events?.items) || !events.items.some((item) => item.id === event.id)) throw new Error(`Canonical TemporalRange overlap query did not return the created Event: ${JSON.stringify(events)}`);
  const venueResults = await expectData(`/api/v1/spaces/${spaceId}/models/event/records/query`, {
    method: "POST",
    body: { search: { text: "Staging synthetic venue" }, page: { limit: 20 } },
  });
  if (!venueResults.items?.some((item) => item.id === event.id)) {
    throw new Error("Event Location name search did not return the synthetic venue");
  }
  const nearby = await expectData(`/api/v1/spaces/${spaceId}/models/event/records/query`, {
    method: "POST",
    body: {
      filter: { field: "location", op: "withinDistance",
        value: { point: { latitude: 0, longitude: 0 }, meters: 50 } },
      page: { limit: 20 },
    },
  });
  if (!nearby.items?.some((item) => item.id === event.id)) {
    throw new Error("Event Location WGS84 proximity query did not return the synthetic point");
  }

  const anchor = addDays(today, -1);
  const day = await expectData(`/api/v1/spaces/${spaceId}/models/day_record/records`, {
    method: "POST", body: { name: `Staging day ${marker}`, kind: "elapsed", anchorDate: anchor, subjectPersonId: personId },
  }, 201);
  cleanup.push({ modelKey: "day_record", id: day.id, version: day.version });
  if (day.status !== "active" || day.computed?.temporal?.elapsedDays !== 1) throw new Error(`Temporal computed mismatch: ${JSON.stringify(day)}`);
  const advanced = await expectData(`/api/v1/spaces/${spaceId}/models/day_record/records/${day.id}/actions/record-occurrence`, {
    method: "POST", body: { version: day.version, occurredOn: today, note: marker },
  });
  cleanup.at(-1).version = advanced.version;
  if (advanced.anchorDate !== today) throw new Error(`Temporal occurrence did not advance anchor: ${JSON.stringify(advanced)}`);
  const occurrences = await expectData(`/api/v1/spaces/${spaceId}/models/day_record/records/${day.id}/occurrences?limit=20`);
  if (!Array.isArray(occurrences?.items) || occurrences.items.length < 2) throw new Error(`Temporal occurrence history mismatch: ${JSON.stringify(occurrences)}`);

  const wish = await expectData(`/api/v1/spaces/${spaceId}/models/wish/records`, {
    method: "POST", body: { ownerPersonId: personId, title: `Staging wish ${marker}` },
  }, 201);
  cleanup.push({ modelKey: "wish", id: wish.id, version: wish.version });
  if (wish.status !== "open" || wish.ownerPersonId !== personId || wish.fulfilledAt != null) {
    throw new Error(`Wish default/owner mismatch: ${JSON.stringify(wish)}`);
  }

  const retiredWishActions = ["claim", "unclaim", "archive", "restore"];
  for (const retiredAction of retiredWishActions) {
    const retired = await request(`/api/v1/spaces/${spaceId}/models/wish/records/${wish.id}/actions/${retiredAction}`, {
      method: "POST",
      body: { version: wish.version },
    });
    if (retired.status !== 404 || retired.payload?.error?.code !== "ACTION_NOT_FOUND") {
      throw new Error(`Retired Wish action ${retiredAction} unexpectedly remains available: expected 404 ACTION_NOT_FOUND, got ${retired.status}: ${JSON.stringify(retired.payload)}`);
    }
  }

  const secondaryEdit = await request(`/api/v1/spaces/${spaceId}/models/wish/records/${wish.id}`, {
    method: "PATCH",
    bearer: secondaryBearer,
    body: { version: wish.version, title: `Unauthorized edit ${marker}` },
  });
  if (secondaryEdit.status !== 403 || secondaryEdit.payload?.error?.code !== "POLICY_DENIED") {
    throw new Error(`Wish owner-only content edit policy mismatch: expected 403 POLICY_DENIED, got ${secondaryEdit.status}: ${JSON.stringify(secondaryEdit.payload)}`);
  }

  const fulfilledBySecondary = await expectData(`/api/v1/spaces/${spaceId}/models/wish/records/${wish.id}/actions/fulfill`, {
    method: "POST", bearer: secondaryBearer, body: { version: wish.version },
  });
  cleanup.at(-1).version = fulfilledBySecondary.version;
  if (fulfilledBySecondary.status !== "fulfilled" || !fulfilledBySecondary.fulfilledAt) {
    throw new Error(`Wish direct fulfill Workflow mismatch for authorized non-owner: ${JSON.stringify(fulfilledBySecondary)}`);
  }

  const reopenedBySecondary = await expectData(`/api/v1/spaces/${spaceId}/models/wish/records/${wish.id}/actions/reopen`, {
    method: "POST", bearer: secondaryBearer, body: { version: fulfilledBySecondary.version },
  });
  cleanup.at(-1).version = reopenedBySecondary.version;
  if (reopenedBySecondary.status !== "open" || reopenedBySecondary.fulfilledAt != null) {
    throw new Error(`Wish reopen Workflow mismatch for authorized non-owner: ${JSON.stringify(reopenedBySecondary)}`);
  }

  const fulfilledByOwner = await expectData(`/api/v1/spaces/${spaceId}/models/wish/records/${wish.id}/actions/fulfill`, {
    method: "POST", body: { version: reopenedBySecondary.version },
  });
  cleanup.at(-1).version = fulfilledByOwner.version;
  if (fulfilledByOwner.status !== "fulfilled" || !fulfilledByOwner.fulfilledAt) {
    throw new Error(`Wish direct fulfill Workflow mismatch for owner: ${JSON.stringify(fulfilledByOwner)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    marker,
    task: { id: task.id, workflow: "complete/reopen" },
    event: { id: event.id, temporalRange: true, canonicalOverlapQuery: true, location: true, locationNameSearch: true, withinDistance: true },
    dayRecord: { id: day.id, temporalOccurrence: true },
    wish: {
      id: wish.id,
      retiredActionsAbsent: retiredWishActions,
      ownerOnlyContentEdit: true,
      secondaryUserFulfill: true,
      secondaryUserReopen: true,
      ownerFulfill: true,
      workflow: "fulfill/reopen",
    },
  }, null, 2));
} finally {
  for (const record of cleanup.reverse()) await deleteRecord(record.modelKey, record.id, record.version);
}

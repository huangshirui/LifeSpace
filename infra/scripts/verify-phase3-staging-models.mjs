import process from "node:process";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const bearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const personId = process.env.LIFESPACE_STAGING_PERSON_ID ?? "";
const spaceTimezone = process.env.LIFESPACE_STAGING_SPACE_TIMEZONE ?? "UTC";

for (const [name, value] of Object.entries({
  LIFESPACE_CORE_STAGING_URL: coreBaseUrl,
  LIFESPACE_STAGING_USER_BEARER: bearer,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
  LIFESPACE_STAGING_PERSON_ID: personId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

function localDate(timeZone, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day + days));
  return instant.toISOString().slice(0, 10);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${coreBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`);
    }
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

async function deleteRecord(route, id, version) {
  const result = await request(`/api/v1/spaces/${spaceId}/${route}/${id}`, {
    method: "DELETE",
    body: { version },
  });
  if (result.status !== 204 && result.status !== 404) {
    console.warn(`Cleanup ${route}/${id} failed with ${result.status}: ${JSON.stringify(result.payload)}`);
  }
}

const marker = `phase3-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const cleanup = [];
const today = localDate(spaceTimezone);

try {
  // Task: declarative server default + Workflow complete/reopen.
  const task = await expectData(`/api/v1/spaces/${spaceId}/tasks`, {
    method: "POST",
    body: { name: `Phase 3 task ${marker}`, assigneePersonIds: [personId] },
  }, 201);
  cleanup.push({ route: "tasks", id: task.id, version: task.version });
  if (task.status !== "pending" || task.version !== 1) {
    throw new Error(`Task default/runtime mismatch: ${JSON.stringify(task)}`);
  }
  const completed = await expectData(`/api/v1/spaces/${spaceId}/tasks/${task.id}/actions/complete`, {
    method: "POST",
    body: { version: task.version },
  });
  cleanup[cleanup.length - 1].version = completed.version;
  if (completed.status !== "completed" || !completed.completedAt) {
    throw new Error(`Task complete Workflow mismatch: ${JSON.stringify(completed)}`);
  }
  const reopened = await expectData(`/api/v1/spaces/${spaceId}/tasks/${task.id}/actions/reopen`, {
    method: "POST",
    body: { version: completed.version },
  });
  cleanup[cleanup.length - 1].version = reopened.version;
  if (reopened.status !== "pending" || reopened.completedAt !== null) {
    throw new Error(`Task reopen Workflow mismatch: ${JSON.stringify(reopened)}`);
  }

  // Event: Calendar timed interval + attendee relation + overlap query.
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 45 * 60 * 1000);
  const event = await expectData(`/api/v1/spaces/${spaceId}/events`, {
    method: "POST",
    body: {
      summary: `Phase 3 event ${marker}`,
      isAllDay: false,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      startTimezone: "UTC",
      endTimezone: "UTC",
      attendeePersonIds: [personId],
    },
  }, 201);
  cleanup.push({ route: "events", id: event.id, version: event.version });
  if (event.status !== "active" || event.isAllDay !== false) {
    throw new Error(`Event Calendar/default mismatch: ${JSON.stringify(event)}`);
  }
  const events = await expectData(
    `/api/v1/spaces/${spaceId}/events?rangeStart=${encodeURIComponent(new Date(start.getTime() - 60_000).toISOString())}&rangeEnd=${encodeURIComponent(new Date(end.getTime() + 60_000).toISOString())}&limit=20`,
  );
  if (!Array.isArray(events?.items) || !events.items.some((item) => item.id === event.id)) {
    throw new Error(`Calendar overlap query did not return the created Event: ${JSON.stringify(events)}`);
  }

  // Day Record: Temporal computation + initial/manual occurrence + atomic anchor advancement.
  const anchor = addDays(today, -1);
  const day = await expectData(`/api/v1/spaces/${spaceId}/day-records`, {
    method: "POST",
    body: {
      name: `Phase 3 day ${marker}`,
      kind: "elapsed",
      anchorDate: anchor,
      subjectPersonId: personId,
    },
  }, 201);
  cleanup.push({ route: "day-records", id: day.id, version: day.version });
  if (day.status !== "active" || day.computed?.temporal?.elapsedDays !== 1) {
    throw new Error(`Temporal computed mismatch: ${JSON.stringify(day)}`);
  }
  const advanced = await expectData(`/api/v1/spaces/${spaceId}/day-records/${day.id}/actions/record-occurrence`, {
    method: "POST",
    body: { version: day.version, occurredOn: today, note: marker },
  });
  cleanup[cleanup.length - 1].version = advanced.version;
  if (advanced.anchorDate !== today) {
    throw new Error(`Temporal occurrence did not advance anchor: ${JSON.stringify(advanced)}`);
  }
  const occurrences = await expectData(`/api/v1/spaces/${spaceId}/day-records/${day.id}/occurrences?limit=20`);
  if (!Array.isArray(occurrences?.items) || occurrences.items.length < 2) {
    throw new Error(`Temporal occurrence history mismatch: ${JSON.stringify(occurrences)}`);
  }

  // Wish: Policy + Workflow claim/unclaim while owner relation remains immutable.
  const wish = await expectData(`/api/v1/spaces/${spaceId}/wishes`, {
    method: "POST",
    body: {
      ownerPersonId: personId,
      title: `Phase 3 wish ${marker}`,
    },
  }, 201);
  cleanup.push({ route: "wishes", id: wish.id, version: wish.version });
  if (wish.status !== "open" || wish.ownerPersonId !== personId) {
    throw new Error(`Wish default/owner mismatch: ${JSON.stringify(wish)}`);
  }
  const claimed = await expectData(`/api/v1/spaces/${spaceId}/wishes/${wish.id}/actions/claim`, {
    method: "POST",
    body: { version: wish.version },
  });
  cleanup[cleanup.length - 1].version = claimed.version;
  if (claimed.status !== "claimed" || claimed.claimantPersonId !== personId) {
    throw new Error(`Wish claim Workflow mismatch: ${JSON.stringify(claimed)}`);
  }
  const unclaimed = await expectData(`/api/v1/spaces/${spaceId}/wishes/${wish.id}/actions/unclaim`, {
    method: "POST",
    body: { version: claimed.version },
  });
  cleanup[cleanup.length - 1].version = unclaimed.version;
  if (unclaimed.status !== "open" || unclaimed.claimantPersonId !== null) {
    throw new Error(`Wish unclaim Workflow mismatch: ${JSON.stringify(unclaimed)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    marker,
    task: { id: task.id, workflow: "complete/reopen" },
    event: { id: event.id, calendarOverlap: true },
    dayRecord: { id: day.id, temporalOccurrence: true },
    wish: { id: wish.id, workflow: "claim/unclaim" },
  }, null, 2));
} finally {
  for (const record of cleanup.reverse()) {
    await deleteRecord(record.route, record.id, record.version);
  }
}

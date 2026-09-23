import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { queryCalendarResources } from "../src/calendar-query";
import type { PublishedModel } from "../src/model-registry";
import { LEGACY_CALENDAR_MODEL, ensureLegacyCalendarStorage } from "./legacy-calendar-fixture";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_calendar_viewing_window_test",
  clientId: "app_test_runtime",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_calendar_viewing_window_test",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  await ensureLegacyCalendarStorage(db);
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const personId = `per_${suffix}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Calendar Window", actor.id, now, now, "UTC"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, actor.id, "Calendar Viewer", now, now),
  ]);
  return { db, spaceId, personId, model: LEGACY_CALENDAR_MODEL };
}

async function timed(
  spaceId: string,
  model: PublishedModel,
  summary: string,
  startAt: string,
  endAt: string,
  attendeePersonIds: string[] = [],
) {
  return createGenericResource(bindings(), actor, spaceId, model, {
    summary,
    isAllDay: false,
    startAt,
    endAt,
    startTimezone: "UTC",
    endTimezone: "UTC",
    attendeePersonIds,
    status: "active",
  });
}

async function allDay(
  spaceId: string,
  model: PublishedModel,
  summary: string,
  startDate: string,
  endDateExclusive: string,
  attendeePersonIds: string[] = [],
) {
  return createGenericResource(bindings(), actor, spaceId, model, {
    summary,
    isAllDay: true,
    startDate,
    endDateExclusive,
    attendeePersonIds,
    status: "active",
  });
}

function viewingParams(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    windowStartDate: "2026-09-10",
    windowEndDateExclusive: "2026-09-11",
    viewingTimezone: "Asia/Shanghai",
    sort: "calendarStart:asc",
    ...overrides,
  });
}

describe("Calendar viewing-window query", () => {
  it("uses viewing timezone for mixed all-day/timed ordering while preserving overlap semantics", async () => {
    const { spaceId, model } = await fixture();
    const day = await allDay(spaceId, model, "All day", "2026-09-10", "2026-09-11");
    const early = await timed(spaceId, model, "00:30 local", "2026-09-09T16:30:00.000Z", "2026-09-09T17:00:00.000Z");
    const late = await timed(spaceId, model, "09:00 local", "2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z");
    await timed(spaceId, model, "Next day", "2026-09-10T16:30:00.000Z", "2026-09-10T17:00:00.000Z");

    const asc = await queryCalendarResources(bindings(), actor, spaceId, model, viewingParams());
    expect(asc.items.map((item) => item.id)).toEqual([day.id, early.id, late.id]);

    const desc = await queryCalendarResources(bindings(), actor, spaceId, model, viewingParams({ sort: "calendarStart:desc" }));
    expect(desc.items.map((item) => item.id)).toEqual([day.id, late.id, early.id]);
  });

  it("includes timed and all-day records that overlap the viewing window even when they start earlier", async () => {
    const { spaceId, model } = await fixture();
    const timedCrossing = await timed(
      spaceId,
      model,
      "Cross midnight",
      "2026-09-09T15:30:00.000Z",
      "2026-09-09T16:30:00.000Z",
    );
    const allDayCrossing = await allDay(spaceId, model, "Multi-day", "2026-09-09", "2026-09-11");

    const result = await queryCalendarResources(bindings(), actor, spaceId, model, viewingParams());
    expect(new Set(result.items.map((item) => item.id))).toEqual(new Set([timedCrossing.id, allDayCrossing.id]));
  });

  it("derives a DST-safe timed window from local dates while all-day overlap remains date-to-date", async () => {
    const { spaceId, model } = await fixture();
    const insideEarly = await timed(spaceId, model, "DST early", "2026-03-28T23:30:00.000Z", "2026-03-29T00:00:00.000Z");
    const insideLate = await timed(spaceId, model, "DST late", "2026-03-29T21:30:00.000Z", "2026-03-29T21:45:00.000Z");
    await timed(spaceId, model, "DST outside", "2026-03-29T22:30:00.000Z", "2026-03-29T23:00:00.000Z");
    const day = await allDay(spaceId, model, "DST all-day", "2026-03-29", "2026-03-30");

    const result = await queryCalendarResources(bindings(), actor, spaceId, model, new URLSearchParams({
      windowStartDate: "2026-03-29",
      windowEndDateExclusive: "2026-03-30",
      viewingTimezone: "Europe/Amsterdam",
      sort: "calendarStart:asc",
    }));
    expect(new Set(result.items.map((item) => item.id))).toEqual(new Set([insideEarly.id, insideLate.id, day.id]));
  });

  it("paginates a merged all-day/timed order without skipping or duplicating either stream", async () => {
    const { spaceId, model } = await fixture();
    const expected = [
      await allDay(spaceId, model, "All day", "2026-09-10", "2026-09-11"),
      await timed(spaceId, model, "00:30", "2026-09-09T16:30:00.000Z", "2026-09-09T17:00:00.000Z"),
      await timed(spaceId, model, "09:00", "2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z"),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < expected.length; page += 1) {
      const params = viewingParams({ limit: "1", ...(cursor ? { cursor } : {}) });
      const result = await queryCalendarResources(bindings(), actor, spaceId, model, params);
      expect(result.items).toHaveLength(1);
      seen.push(result.items[0]!.id);
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(expected.map((item) => item.id));
    expect(cursor).toBeNull();
  });

  it("keeps descending merged pagination stable when timed records share the same start instant", async () => {
    const { spaceId, model } = await fixture();
    const day = await allDay(spaceId, model, "All day", "2026-09-10", "2026-09-11");
    const early = await timed(spaceId, model, "Early", "2026-09-09T16:30:00.000Z", "2026-09-09T17:00:00.000Z");
    const tiedA = await timed(spaceId, model, "Tied A", "2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z");
    const tiedB = await timed(spaceId, model, "Tied B", "2026-09-10T01:00:00.000Z", "2026-09-10T02:30:00.000Z");
    const tied = [tiedA, tiedB].sort((left, right) => left.id.localeCompare(right.id));
    const expected = [day, ...tied, early];

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < expected.length; page += 1) {
      const params = viewingParams({
        sort: "calendarStart:desc",
        limit: "1",
        ...(cursor ? { cursor } : {}),
      });
      const result = await queryCalendarResources(bindings(), actor, spaceId, model, params);
      expect(result.items).toHaveLength(1);
      seen.push(result.items[0]!.id);
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(expected.map((item) => item.id));
    expect(cursor).toBeNull();
  });

  it("composes attendee me with the high-level window", async () => {
    const { spaceId, personId, model } = await fixture();
    const mine = await timed(
      spaceId,
      model,
      "Mine",
      "2026-09-09T16:30:00.000Z",
      "2026-09-09T17:00:00.000Z",
      [personId],
    );
    await timed(spaceId, model, "Other", "2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z");

    const result = await queryCalendarResources(bindings(), actor, spaceId, model, viewingParams({ attendeePersonIds: "me" }));
    expect(result.items.map((item) => item.id)).toEqual([mine.id]);
  });

  it("rejects incomplete, invalid, or mixed viewing-window transport and preserves legacy low-level syntax", async () => {
    const { spaceId, model } = await fixture();
    const record = await timed(spaceId, model, "Legacy", "2026-09-09T16:30:00.000Z", "2026-09-09T17:00:00.000Z");

    await expect(queryCalendarResources(bindings(), actor, spaceId, model, new URLSearchParams({
      windowStartDate: "2026-09-10",
      windowEndDateExclusive: "2026-09-11",
    }))).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });

    await expect(queryCalendarResources(bindings(), actor, spaceId, model, viewingParams({ viewingTimezone: "Mars/Olympus" })))
      .rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });

    await expect(queryCalendarResources(bindings(), actor, spaceId, model, viewingParams({
      rangeStart: "2026-09-09T16:00:00.000Z",
      rangeEnd: "2026-09-10T16:00:00.000Z",
    }))).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });

    const legacy = await queryCalendarResources(bindings(), actor, spaceId, model, new URLSearchParams({
      rangeStart: "2026-09-09T16:00:00.000Z",
      rangeEnd: "2026-09-10T16:00:00.000Z",
      dateStart: "2026-09-10",
      dateEndExclusive: "2026-09-11",
      sort: "calendarStart:asc",
    }));
    expect(legacy.items.map((item) => item.id)).toEqual([record.id]);
  });
});

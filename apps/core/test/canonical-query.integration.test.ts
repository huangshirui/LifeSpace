import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { queryCanonicalResources } from "../src/canonical-query";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import type { ModelDefinition } from "../src/model-definition";
import { getPublishedModel, publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_canonical_query_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_canonical_query_test",
};

async function createSpaceFixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const personA = `per_${suffix}`;
  const personB = `per_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Canonical Query", actor.id, now, now, "Asia/Shanghai"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personA, spaceId, actor.id, "Me", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personB, spaceId, null, "Other", now, now),
  ]);
  return { spaceId, personA, personB };
}

async function taskFixture() {
  const { spaceId, personA, personB } = await createSpaceFixture();
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  const weekA = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "FTC materials",
    dueDate: "2026-09-15",
    assigneePersonIds: [personA],
  });
  const weekBoth = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "FTC checklist",
    dueDate: "2026-09-16",
    assigneePersonIds: [personA, personB],
  });
  const future = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "School form",
    dueDate: "2026-10-01",
    assigneePersonIds: [personB],
  });
  const noDue = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "FTC someday",
    assigneePersonIds: [],
  });
  return { spaceId, personA, personB, model, weekA, weekBoth, future, noDue };
}

async function timed(
  spaceId: string,
  model: NonNullable<Awaited<ReturnType<typeof getPublishedModel>>>,
  summary: string,
  startAt: string,
  endAt: string,
  attendeePersonIds: string[] = [],
) {
  return createGenericResource(bindings(), actor, spaceId, model, {
    summary,
    when: { kind: "instant", start: startAt, endExclusive: endAt },
    attendeePersonIds,
    status: "active",
  });
}

async function allDay(
  spaceId: string,
  model: NonNullable<Awaited<ReturnType<typeof getPublishedModel>>>,
  summary: string,
  startDate: string,
  endDateExclusive: string,
  attendeePersonIds: string[] = [],
) {
  return createGenericResource(bindings(), actor, spaceId, model, {
    summary,
    when: { kind: "date", start: startDate, endExclusive: endDateExclusive },
    attendeePersonIds,
    status: "active",
  });
}

async function temporalRangeFixture() {
  const { spaceId } = await createSpaceFixture();
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const definition: ModelDefinition = {
    definitionVersion: 1,
    key: `temporal_query_${suffix}`,
    display: { singular: "Temporal Query", plural: "Temporal Queries" },
    fields: {
      name: { type: "string", required: true },
      when: { type: "temporal_range", nullable: true },
    },
    query: { filterable: ["when"], sortable: ["when"] },
    access: ["read", "write"],
  };
  const publisher: Principal = {
    type: "service",
    id: "svc_temporal_query_test",
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: "tok_temporal_query_test",
  };
  const model = await publishModelDefinition(bindings(), publisher, definition, "initial");
  const date = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "All day",
    when: { kind: "date", start: "2026-09-20", endExclusive: "2026-09-21" },
  });
  const instant = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Timed inside",
    when: {
      kind: "instant",
      start: "2026-09-20T02:00:00.000Z",
      endExclusive: "2026-09-20T03:00:00.000Z",
    },
  });
  await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Timed outside",
    when: {
      kind: "instant",
      start: "2026-09-21T02:00:00.000Z",
      endExclusive: "2026-09-21T03:00:00.000Z",
    },
  });
  const unscheduled = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Unscheduled",
    when: null,
  });
  return { spaceId, model, date, instant, unscheduled };
}

describe("Canonical Typed Query", () => {
  it("canonicalizes timezone fields consistently at write and query boundaries", async () => {
    const { spaceId } = await createSpaceFixture();
    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const definition: ModelDefinition = {
      definitionVersion: 1,
      key: `timezone_query_${suffix}`,
      display: { singular: "Timezone Query", plural: "Timezone Queries" },
      fields: {
        name: { type: "string", required: true },
        timezone: { type: "timezone", required: true },
      },
      query: { filterable: ["timezone"] },
      access: ["read", "write"],
    };
    const publisher: Principal = {
      type: "service",
      id: "svc_timezone_query_test",
      clientId: "lifespace-platform-admin",
      scopes: ["models:manage"],
      tokenId: "tok_timezone_query_test",
    };
    const model = await publishModelDefinition(bindings(), publisher, definition, "initial");
    const created = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Shanghai",
      timezone: "asia/shanghai",
    });
    expect(created.data.timezone).toBe("Asia/Shanghai");

    const result = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { field: "timezone", op: "eq", value: "ASIA/SHANGHAI" },
    });
    expect(result.items.map((item) => item.id)).toEqual([created.id]);
  });


  it("supports nested Boolean filters, local date windows and null predicates", async () => {
    const { spaceId, model, weekA, weekBoth, noDue } = await taskFixture();
    const result = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: {
        and: [
          { field: "status", op: "eq", value: "pending" },
          {
            or: [
              {
                field: "dueDate",
                op: "within",
                value: {
                  kind: "local_date_window",
                  startDate: "2026-09-14",
                  endDateExclusive: "2026-09-21",
                  timezone: "Asia/Shanghai",
                },
              },
              { field: "dueDate", op: "isNull" },
            ],
          },
        ],
      },
      sort: [{ field: "dueDate", direction: "asc" }],
    });
    expect(result.items.map((item) => item.id)).toEqual([weekA.id, weekBoth.id, noDue.id]);
  });

  it("expresses relation containsAny/containsAll through OR/AND over the contains primitive", async () => {
    const { spaceId, personA, personB, model, weekA, weekBoth, future } = await taskFixture();
    const any = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: {
        or: [
          { field: "assigneePersonIds", op: "contains", value: personA },
          { field: "assigneePersonIds", op: "contains", value: personB },
        ],
      },
    });
    expect(new Set(any.items.map((item) => item.id))).toEqual(new Set([weekA.id, weekBoth.id, future.id]));

    const all = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: {
        and: [
          { field: "assigneePersonIds", op: "contains", value: personA },
          { field: "assigneePersonIds", op: "contains", value: personB },
        ],
      },
    });
    expect(all.items.map((item) => item.id)).toEqual([weekBoth.id]);
  });

  it("composes Search + Filter + multi-sort + cursor and binds normalized semantics", async () => {
    const { spaceId, model, weekA, weekBoth } = await taskFixture();
    const first = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "FTC" },
      filter: {
        and: [
          { field: "status", op: "eq", value: "pending" },
          { field: "dueDate", op: "lte", value: "2026-09-30" },
        ],
      },
      sort: [
        { field: "dueDate", direction: "asc" },
        { field: "name", direction: "asc" },
      ],
      page: { limit: 1 },
    });
    expect(first.items.map((item) => item.id)).toEqual([weekA.id]);
    expect(first.nextCursor).toBeTruthy();

    const second = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "FTC" },
      filter: {
        and: [
          { field: "dueDate", op: "lte", value: "2026-09-30" },
          { field: "status", op: "eq", value: "pending" },
        ],
      },
      sort: [
        { field: "dueDate", direction: "asc" },
        { field: "name", direction: "asc" },
      ],
      page: { limit: 5, cursor: first.nextCursor },
    });
    expect(second.items.map((item) => item.id)).toEqual([weekBoth.id]);
    expect(second.nextCursor).toBeNull();
  });

  it("queries canonical Event date and instant variants through one when target", async () => {
    const { spaceId, personA } = await createSpaceFixture();
    const model = await getPublishedModel(bindings(), "event");
    if (!model) throw new Error("bootstrap Event model is missing");
    const day = await allDay(spaceId, model, "School day", "2026-09-20", "2026-09-21", [personA]);
    const timedInside = await timed(
      spaceId,
      model,
      "School meeting",
      "2026-09-20T02:00:00.000Z",
      "2026-09-20T03:00:00.000Z",
      [personA],
    );
    await timed(spaceId, model, "School next day", "2026-09-21T02:00:00.000Z", "2026-09-21T03:00:00.000Z", [personA]);

    const result = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "School" },
      filter: {
        and: [
          {
            field: "when",
            op: "overlaps",
            value: {
              kind: "local_date_window",
              startDate: "2026-09-20",
              endDateExclusive: "2026-09-21",
              timezone: "Asia/Shanghai",
            },
          },
          { field: "attendeePersonIds", op: "contains", value: "me" },
        ],
      },
      sort: [{ field: "summary", direction: "asc" }],
    });
    expect(new Set(result.items.map((item) => item.id))).toEqual(new Set([day.id, timedInside.id]));
  });

  it("supports TemporalRange kindIs composition and invalidates cursors when viewing context changes", async () => {
    const { spaceId } = await createSpaceFixture();
    const model = await getPublishedModel(bindings(), "event");
    if (!model) throw new Error("bootstrap Event model is missing");
    const day = await allDay(spaceId, model, "All day", "2026-09-20", "2026-09-21");
    await timed(spaceId, model, "Timed", "2026-09-20T02:00:00.000Z", "2026-09-20T03:00:00.000Z");

    const baseFilter = {
      and: [
        {
          field: "when",
          op: "overlaps",
          value: {
            kind: "local_date_window",
            startDate: "2026-09-20",
            endDateExclusive: "2026-09-21",
            timezone: "Asia/Shanghai",
          },
        },
        { field: "when", op: "kindIs", value: "date" },
      ],
    } as const;
    const first = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: baseFilter,
      sort: [{ field: "summary", direction: "asc" }],
      page: { limit: 1 },
    });
    expect(first.items.map((item) => item.id)).toEqual([day.id]);

    if (first.nextCursor) {
      await expect(queryCanonicalResources(bindings(), actor, spaceId, model, {
        filter: {
          and: [
            {
              field: "when",
              op: "overlaps",
              value: {
                kind: "local_date_window",
                startDate: "2026-09-20",
                endDateExclusive: "2026-09-21",
                timezone: "Asia/Tokyo",
              },
            },
            { field: "when", op: "kindIs", value: "date" },
          ],
        },
        sort: [{ field: "summary", direction: "asc" }],
        page: { limit: 1, cursor: first.nextCursor },
      })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    }
  });
  it("filters direct TemporalRange fields with range, kind, local-window, and null semantics", async () => {
    const { spaceId, model, date, instant, unscheduled } = await temporalRangeFixture();
    const localWindow = {
      kind: "local_date_window",
      startDate: "2026-09-20",
      endDateExclusive: "2026-09-21",
      timezone: "Asia/Shanghai",
    } as const;

    const mixed = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { field: "when", op: "overlaps", value: localWindow },
    });
    expect(new Set(mixed.items.map((item) => item.id))).toEqual(new Set([date.id, instant.id]));
    expect(mixed.items.find((item) => item.id === instant.id)?.data.when).toEqual({
      kind: "instant",
      start: "2026-09-20T02:00:00.000Z",
      endExclusive: "2026-09-20T03:00:00.000Z",
    });

    const allDay = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: {
        and: [
          { field: "when", op: "overlaps", value: localWindow },
          { field: "when", op: "kindIs", value: "date" },
        ],
      },
    });
    expect(allDay.items.map((item) => item.id)).toEqual([date.id]);

    const timed = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: {
        field: "when",
        op: "contains",
        value: {
          kind: "instant",
          start: "2026-09-20T02:15:00.000Z",
          endExclusive: "2026-09-20T02:45:00.000Z",
        },
      },
    });
    expect(timed.items.map((item) => item.id)).toEqual([instant.id]);

    const nulls = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { field: "when", op: "isNull" },
    });
    expect(nulls.items.map((item) => item.id)).toEqual([unscheduled.id]);
  });

  it("sorts TemporalRange by projected start/end, keeps null last, and binds viewing context to cursors", async () => {
    const { spaceId, model, date, instant, unscheduled } = await temporalRangeFixture();
    const context = { viewingTimezone: "Asia/Shanghai" };

    await expect(queryCanonicalResources(bindings(), actor, spaceId, model, {
      sort: [{ field: "when", direction: "asc" }],
    })).rejects.toMatchObject({ code: "INVALID_QUERY" });

    const first = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      context,
      sort: [{ field: "when", direction: "asc" }],
      page: { limit: 2 },
    });
    expect(first.items.map((item) => item.id)).toEqual([date.id, instant.id]);
    expect(first.nextCursor).toBeTruthy();

    const second = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      context,
      sort: [{ field: "when", direction: "asc" }],
      page: { limit: 2, cursor: first.nextCursor },
    });
    expect(second.items.at(-1)?.id).toBe(unscheduled.id);
    expect(new Set([
      ...first.items.map((item) => item.id),
      ...second.items.map((item) => item.id),
    ]).size).toBe(4);

    await expect(queryCanonicalResources(bindings(), actor, spaceId, model, {
      context: { viewingTimezone: "Asia/Tokyo" },
      sort: [{ field: "when", direction: "asc" }],
      page: { limit: 2, cursor: first.nextCursor },
    })).rejects.toMatchObject({ code: "INVALID_QUERY" });

    const descending = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      context,
      sort: [{ field: "when", direction: "desc" }],
    });
    expect(descending.items.at(-1)?.id).toBe(unscheduled.id);

    await expect(queryCanonicalResources(bindings(), actor, spaceId, model, {
      context,
      sort: [{ field: "createdAt", direction: "asc" }],
    })).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

});

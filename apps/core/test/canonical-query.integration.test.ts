import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { queryCanonicalResources } from "../src/canonical-query";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import type { ModelDefinition } from "../src/model-definition";
import { getPublishedModel, publishModelDefinition } from "../src/model-registry";
import { countingDatabase, type DatabaseCost } from "./support/counting-database";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_canonical_query_test",
  clientId: "app_test_runtime",
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
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Canonical Query", actor.id, now, now, "Asia/Shanghai"),
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

  it("searches full-length literal substrings without D1 LIKE pattern failures", async () => {
    const { spaceId, model } = await taskFixture();
    const longText = "q".repeat(100);
    const longRecord = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Long literal search",
      description: longText,
    });
    const symbols = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Symbols %_\\ marker",
    });

    for (const length of [48, 49, 50, 100]) {
      const page = await queryCanonicalResources(bindings(), actor, spaceId, model, {
        search: { text: "Q".repeat(length) },
        page: { limit: 10 },
      });
      expect(page.items.map((item) => item.id)).toEqual([longRecord.id]);
    }
    for (const literal of ["%", "_", "\\", "%_\\"]) {
      const page = await queryCanonicalResources(bindings(), actor, spaceId, model, {
        search: { text: literal },
      });
      expect(page.items.map((item) => item.id)).toEqual([symbols.id]);
    }
    const missing = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "x".repeat(100) },
    });
    expect(missing.items).toHaveLength(0);
    await expect(queryCanonicalResources(bindings(), actor, spaceId, model, {
      search: { text: "q".repeat(101) },
    })).rejects.toMatchObject({ status: 400 });
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

describe("Canonical relation membership read-amplification regression (#591)", () => {
  it("uses an independent target-set lookup and bounds rows read across cursor pages", async () => {
    const db = (env as unknown as TestEnv).DB;
    const { spaceId, personA, personB } = await createSpaceFixture();
    const task = await getPublishedModel(bindings(), "task");
    const wish = await getPublishedModel(bindings(), "wish");
    if (!task || !wish) throw new Error("missing baseline models");
    const prefix = "rec_" + spaceId.slice(4) + "_";
    const now = "2026-11-16T00:00:00.000Z";
    // 240 candidate Tasks and 600 unrelated Wishes share a Person. The old
    // target-leading correlated EXISTS could repeatedly read all those edges.
    const seq = "WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM seq WHERE i+1<?)";
    for (const [model, size, field, label, state] of [
      [task, 240, "assigneePersonIds", "name", "pending"],
      [wish, 600, "ownerPersonId", "title", "open"],
    ] as const) {
      const key = model.key;
      const idPrefix = prefix + key + "_";
      // Fixed trusted fixture table and column names; no application input.
      const table = key === "task" ? "mdl_task" : "mdl_wish";
      const labelColumn = label === "name" ? "name" : "title";
      await db.batch([
        db.prepare(`${seq} INSERT INTO resource_records(
          id,space_id,model_key,model_version,version,
          created_by_type,created_by_id,created_by_entity_type,created_by_name_snapshot,created_at,
          updated_by_type,updated_by_id,updated_by_entity_type,updated_by_name_snapshot,updated_at,
          deleted_at)
          SELECT ?||printf('%04d',i),?,?,?,1,'user',?,'user','Fixture',?,
            'user',?,'user','Fixture',?,CASE WHEN i=239 AND ?='task' THEN ? ELSE NULL END FROM seq`)
          .bind(size, idPrefix, spaceId, key, model.version, actor.id, now, actor.id, now, key, now),
        db.prepare(`${seq} INSERT INTO ${table}(record_id,space_id,${labelColumn},status)
          SELECT ?||printf('%04d',i),?,printf('Fixture %04d',i),? FROM seq`)
          .bind(size, idPrefix, spaceId, state),
        db.prepare(`${seq} INSERT INTO resource_relations(
          source_record_id,source_space_id,source_model_key,field_key,ordinal,target_type,target_person_id,target_record_id)
          SELECT ?||printf('%04d',i),?,?,?,0,'person',CASE WHEN ?='task' AND i%5=0 THEN ? ELSE ? END,NULL FROM seq`)
          .bind(size, idPrefix, spaceId, key, field, key, personB, personA),
      ]);
    }
    const expected = Array.from({ length: 239 }, (_, i) => i)
      .filter(i => i % 5 !== 0).map(i => prefix + "task_" + String(i).padStart(4, "0"));
    const query = {
      filter: { field: "assigneePersonIds", op: "contains", value: personA },
      sort: [{ field: "name", direction: "asc" }],
    };
    const cost: DatabaseCost = { roundTrips: 0, rowsRead: 0, sql: [] };
    const counted = { ...bindings(), DB: countingDatabase(db, cost) };
    const first = await queryCanonicalResources(counted, actor, spaceId, task, {
      ...query, page: { limit: 100 },
    });
    expect(first.items.map(item => item.id)).toEqual(expected.slice(0, 100));
    expect(first.nextCursor).toBeTruthy();
    expect(cost.rowsRead).toBeGreaterThan(0);
    expect(cost.rowsRead).toBeLessThan(6000);
    expect(cost.roundTrips).toBeLessThanOrEqual(3);
    const mainSql = cost.sql.find(sql => sql.includes("r.id IN (SELECT rel.source_record_id"));
    expect(mainSql).toBeDefined();
    const plan = await db.prepare("EXPLAIN QUERY PLAN " + mainSql)
      .bind(spaceId, task.key, "assigneePersonIds", "person", personA, 101).all<{ detail: string }>();
    const details = plan.results.map(row => row.detail).join("\n");
    expect(details).toContain("idx_resource_relations_person");
    expect(details).not.toContain("CORRELATED");
    cost.roundTrips = 0; cost.rowsRead = 0; cost.sql = [];
    const next = await queryCanonicalResources(counted, actor, spaceId, task, {
      ...query, page: { limit: 100, cursor: first.nextCursor },
    });
    expect(next.items.map(item => item.id)).toEqual(expected.slice(100));
    expect(next.nextCursor).toBeNull();
    expect(cost.rowsRead).toBeGreaterThan(0);
    expect(cost.rowsRead).toBeLessThan(6000);
    expect(cost.roundTrips).toBeLessThanOrEqual(3);

    const scalar = await queryCanonicalResources(bindings(), actor, spaceId, wish, {
      filter: { field: "ownerPersonId", op: "contains", value: personA }, page: { limit: 5 },
    });
    expect(scalar.items).toHaveLength(5);
    const other = await createSpaceFixture();
    expect((await queryCanonicalResources(bindings(), actor, other.spaceId, task, query)).items).toEqual([]);
  }, 20_000);

  it("preserves scalar and list record membership without changing the query contract", async () => {
    const { spaceId } = await createSpaceFixture();
    const task = await getPublishedModel(bindings(), "task");
    if (!task) throw new Error("missing Task model");
    const a = await createGenericResource(bindings(), actor, spaceId, task, { name: "Target A" });
    const b = await createGenericResource(bindings(), actor, spaceId, task, { name: "Target B" });
    const model = await publishModelDefinition(bindings(), {
      type: "service", id: "svc_relation_query_test", clientId: "lifespace-platform-admin",
      scopes: ["models:manage"], tokenId: "tok_relation_query_test",
    }, {
      definitionVersion: 1, key: "relation_query_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16),
      display: { singular: "Relation Query", plural: "Relation Queries" },
      fields: {
        name: { type: "string", required: true },
        target: { type: "record", targetModel: "task" },
        targets: { type: "record_list", targetModel: "task" },
      },
      query: { filterable: ["target", "targets"] }, access: ["read", "write"],
    }, "initial");
    const one = await createGenericResource(bindings(), actor, spaceId, model, { name: "One", target: a.id, targets: [a.id, b.id] });
    const two = await createGenericResource(bindings(), actor, spaceId, model, { name: "Two", target: b.id, targets: [b.id] });
    const result = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { and: [{ field: "target", op: "contains", value: a.id }, { field: "targets", op: "contains", value: b.id }] },
    });
    expect(result.items.map(item => item.id)).toEqual([one.id]);
    const either = await queryCanonicalResources(bindings(), actor, spaceId, model, {
      filter: { or: [{ field: "target", op: "contains", value: a.id }, { field: "targets", op: "contains", value: b.id }] },
    });
    expect(new Set(either.items.map(item => item.id))).toEqual(new Set([one.id, two.id]));
  });
});

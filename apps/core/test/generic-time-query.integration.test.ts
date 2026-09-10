import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { queryGenericResources } from "../src/generic-query";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_generic_time_query_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_generic_time_query_test",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
    VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Generic Time Query", actor.id, now, now, "UTC").run();
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  const first = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "First",
    dueDate: "2026-08-12",
    assigneePersonIds: [],
  });
  const second = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Second",
    dueDate: "2026-08-13",
    assigneePersonIds: [],
  });
  const third = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Third",
    dueDate: "2026-08-14",
    assigneePersonIds: [],
  });
  return { db, spaceId, model, first, second, third };
}

describe("Generic Time Query execution", () => {
  // Covers: MDV1-QUERY-COMPARISON-01
  it("keeps legacy From/To inclusive while adding explicit half-open comparison transport", async () => {
    const { spaceId, model, second, third } = await fixture();

    const legacy = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({
      dueDateFrom: "2026-08-13",
      dueDateTo: "2026-08-14",
    }));
    expect(new Set(legacy.items.map((item) => item.id))).toEqual(new Set([second.id, third.id]));

    const halfOpen = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({
      "dueDate.gte": "2026-08-13",
      "dueDate.lt": "2026-08-14",
    }));
    expect(halfOpen.items.map((item) => item.id)).toEqual([second.id]);

    await expect(queryGenericResources(bindings(), spaceId, model, new URLSearchParams({
      dueDateFrom: "2026-08-13",
      "dueDate.gte": "2026-08-13",
    }))).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });
  });

  // Covers: MDV1-QUERY-LOCAL-DATE-WINDOW-01
  it("converts a model datetime local calendar window with the shared DST-safe primitive", async () => {
    const { db, spaceId, model, first, second, third } = await fixture();
    const datetimeModel = structuredClone(model);
    datetimeModel.definition.query = {
      ...(datetimeModel.definition.query ?? {}),
      filterable: [...(datetimeModel.definition.query?.filterable ?? []), "completedAt"],
    };

    await db.batch([
      db.prepare('UPDATE "mdl_task" SET "completedAt"=? WHERE record_id=? AND space_id=?')
        .bind("2026-03-28T23:30:00.000Z", first.id, spaceId),
      db.prepare('UPDATE "mdl_task" SET "completedAt"=? WHERE record_id=? AND space_id=?')
        .bind("2026-03-29T21:30:00.000Z", second.id, spaceId),
      db.prepare('UPDATE "mdl_task" SET "completedAt"=? WHERE record_id=? AND space_id=?')
        .bind("2026-03-29T22:30:00.000Z", third.id, spaceId),
    ]);

    const result = await queryGenericResources(bindings(), spaceId, datetimeModel, new URLSearchParams({
      "completedAt.dateStart": "2026-03-29",
      "completedAt.dateEndExclusive": "2026-03-30",
      "completedAt.timezone": "Europe/Amsterdam",
    }));
    expect(new Set(result.items.map((item) => item.id))).toEqual(new Set([first.id, second.id]));

    await expect(queryGenericResources(bindings(), spaceId, datetimeModel, new URLSearchParams({
      "completedAt.dateStart": "2026-03-29",
      "completedAt.dateEndExclusive": "2026-03-30",
    }))).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });
  });

  it("queries createdAt and updatedAt as platform-owned envelope datetime fields", async () => {
    const { db, spaceId, model, first, second, third } = await fixture();
    await db.batch([
      db.prepare("UPDATE resource_records SET created_at=?,updated_at=? WHERE id=?")
        .bind("2026-03-28T23:30:00.000Z", "2026-09-10T08:00:00.000Z", first.id),
      db.prepare("UPDATE resource_records SET created_at=?,updated_at=? WHERE id=?")
        .bind("2026-03-29T21:30:00.000Z", "2026-09-10T09:00:00.000Z", second.id),
      db.prepare("UPDATE resource_records SET created_at=?,updated_at=? WHERE id=?")
        .bind("2026-03-29T22:30:00.000Z", "2026-09-10T10:00:00.000Z", third.id),
    ]);

    const createdOnLocalDay = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({
      "createdAt.dateStart": "2026-03-29",
      "createdAt.dateEndExclusive": "2026-03-30",
      "createdAt.timezone": "Europe/Amsterdam",
    }));
    expect(new Set(createdOnLocalDay.items.map((item) => item.id))).toEqual(new Set([first.id, second.id]));

    const updatedWindow = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({
      "updatedAt.gte": "2026-09-10T08:30:00Z",
      "updatedAt.lt": "2026-09-10T10:00:00Z",
    }));
    expect(updatedWindow.items.map((item) => item.id)).toEqual([second.id]);
  });

  it("uses Space-scoped envelope indexes for createdAt and updatedAt range plans", async () => {
    const { db, spaceId } = await fixture();
    const createdPlan = await db.prepare(`EXPLAIN QUERY PLAN
      SELECT id FROM resource_records
      WHERE space_id=? AND model_key='task' AND deleted_at IS NULL
        AND created_at>=? AND created_at<?
      ORDER BY created_at DESC,id DESC LIMIT 101`)
      .bind(spaceId, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")
      .all<{ detail: string }>();
    expect(createdPlan.results.some((row) => row.detail.includes("idx_resource_records_space_model"))).toBe(true);

    const updatedPlan = await db.prepare(`EXPLAIN QUERY PLAN
      SELECT id FROM resource_records
      WHERE space_id=? AND model_key='task' AND deleted_at IS NULL
        AND updated_at>=? AND updated_at<?
      ORDER BY updated_at DESC,id DESC LIMIT 101`)
      .bind(spaceId, "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")
      .all<{ detail: string }>();
    expect(updatedPlan.results.some((row) => row.detail.includes("idx_resource_records_space_model_updated"))).toBe(true);
  });
});

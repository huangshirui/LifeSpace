import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY_RECORD_MODEL_DEFINITION } from "../src/builtin-models";
import { addDateDays, spaceToday } from "../src/day-calculation";
import type { Bindings, Principal } from "../src/env";
import { getPublishedModel, publishModelDefinition } from "../src/model-registry";
import { executeWorkflowAction } from "../src/workflow";
import {
  computeTemporalResource,
  createTemporalResource,
  listTemporalOccurrences,
  loadSpaceTemporalContext,
  recordTemporalOccurrence,
  updateTemporalResource,
} from "../src/temporal-capability";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_temporal_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_temporal_test",
};

async function model() {
  const current = await getPublishedModel(bindings(), "day_record");
  if (current) return current;
  const publisher: Principal = {
    type: "service",
    id: "svc_temporal_model_test",
    clientId: "lifespace-platform-admin",
    scopes: ["models:manage"],
    tokenId: "tok_temporal_model_test",
  };
  return publishModelDefinition(bindings(), publisher, DAY_RECORD_MODEL_DEFINITION, "initial");
}

async function fixture(timezone = "America/Los_Angeles") {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
    VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Temporal Test", actor.id, now, now, timezone).run();
  const published = await model();
  const space = await loadSpaceTemporalContext(bindings(), spaceId);
  return { db, spaceId, space, published, today: spaceToday(timezone) };
}

describe("Temporal capability", () => {
  it("applies kind defaults and computes elapsed/countdown/cycle values in Space timezone", async () => {
    const f = await fixture();

    const elapsed = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Since service",
      kind: "elapsed",
      anchorDate: addDateDays(f.today, -5),
    });
    expect(elapsed.data).toMatchObject({
      status: "active",
      cycleDays: null,
      attentionBeforeDays: null,
      attentionAfterDays: null,
    });
    expect(computeTemporalResource(f.published, elapsed, f.space)).toEqual({ elapsedDays: 5 });

    const countdown = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Passport renewal",
      kind: "countdown",
      anchorDate: addDateDays(f.today, 10),
    });
    expect(countdown.data).toMatchObject({
      status: "active",
      attentionBeforeDays: 30,
      attentionAfterDays: null,
      cycleDays: null,
    });
    expect(computeTemporalResource(f.published, countdown, f.space)).toEqual({ remainingDays: 10 });

    const cycle = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Water filter",
      kind: "cycle",
      anchorDate: addDateDays(f.today, -3),
      cycleDays: 14,
    });
    expect(cycle.data).toMatchObject({ status: "active", cycleDays: 14, attentionBeforeDays: 7, attentionAfterDays: null });
    expect(computeTemporalResource(f.published, cycle, f.space)).toEqual({
      nextDueDate: addDateDays(f.today, 11),
      daysUntilDue: 11,
    });
  });

  it("creates initial occurrence only for elapsed/cycle and computes occurrence intervals", async () => {
    const f = await fixture("Asia/Shanghai");
    const anchor = addDateDays(f.today, -6);
    const cycle = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Car maintenance",
      kind: "cycle",
      anchorDate: anchor,
      cycleDays: 30,
    });

    const initial = await listTemporalOccurrences(bindings(), f.spaceId, f.published, cycle.id, 100);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({ occurredOn: anchor, source: "initial", intervalDays: null });

    const occurredOn = addDateDays(f.today, -1);
    const advanced = await recordTemporalOccurrence(
      bindings(),
      actor,
      f.space,
      f.published,
      cycle.id,
      1,
      occurredOn,
      "changed oil",
    );
    expect(advanced.previousAnchorDate).toBe(anchor);
    expect(advanced.intervalDays).toBe(5);
    expect(advanced.record.version).toBe(2);
    expect(advanced.record.data.anchorDate).toBe(occurredOn);
    expect(computeTemporalResource(f.published, advanced.record, f.space)).toMatchObject({
      nextDueDate: addDateDays(occurredOn, 30),
      daysUntilDue: 29,
    });

    const history = await listTemporalOccurrences(bindings(), f.spaceId, f.published, cycle.id, 100);
    expect(history.items).toHaveLength(2);
    expect(history.items[0]).toMatchObject({ occurredOn, source: "manual", intervalDays: 5, note: "changed oil" });

    await expect(recordTemporalOccurrence(bindings(), actor, f.space, f.published, cycle.id, 2, occurredOn, null))
      .rejects.toMatchObject({ code: "DUPLICATE_TEMPORAL_OCCURRENCE", status: 409 });
  });

  it("enforces kind-specific update rules and derives nextDueDate instead of persisting it", async () => {
    const f = await fixture();
    const anchor = addDateDays(f.today, -2);
    const cycle = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "HVAC",
      kind: "cycle",
      anchorDate: anchor,
      cycleDays: 30,
    });

    await expect(updateTemporalResource(bindings(), actor, f.space, f.published, cycle.id, 1, { anchorDate: f.today }))
      .rejects.toMatchObject({ code: "INVALID_TEMPORAL_RULE", status: 400 });

    const updated = await updateTemporalResource(bindings(), actor, f.space, f.published, cycle.id, 1, { cycleDays: 60 });
    expect(updated.data.cycleDays).toBe(60);
    expect(Object.prototype.hasOwnProperty.call(updated.data, "nextDueDate")).toBe(false);
    expect(computeTemporalResource(f.published, updated, f.space)).toMatchObject({ nextDueDate: addDateDays(anchor, 60) });

    const countdown = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Trip",
      kind: "countdown",
      anchorDate: addDateDays(f.today, 3),
    });
    const moved = await updateTemporalResource(bindings(), actor, f.space, f.published, countdown.id, 1, { anchorDate: addDateDays(f.today, 7) });
    expect(moved.data.anchorDate).toBe(addDateDays(f.today, 7));
  });

  it("rejects future elapsed/cycle anchors, countdown occurrences, and archived mutations", async () => {
    const f = await fixture();
    await expect(createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Invalid elapsed",
      kind: "elapsed",
      anchorDate: addDateDays(f.today, 1),
    })).rejects.toMatchObject({ code: "INVALID_TEMPORAL_DATE", status: 400 });

    const countdown = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Countdown",
      kind: "countdown",
      anchorDate: addDateDays(f.today, 5),
    });
    await expect(recordTemporalOccurrence(bindings(), actor, f.space, f.published, countdown.id, 1, f.today, null))
      .rejects.toMatchObject({ code: "OCCURRENCE_NOT_ALLOWED", status: 409 });

    const elapsed = await createTemporalResource(bindings(), actor, f.space, f.published, {
      name: "Archived elapsed",
      kind: "elapsed",
      anchorDate: addDateDays(f.today, -1),
    });
    const archived = await executeWorkflowAction(bindings(), actor, f.spaceId, f.published, elapsed.id, "archive", 1);
    expect(archived.data.status).toBe("archived");
    await expect(updateTemporalResource(bindings(), actor, f.space, f.published, elapsed.id, 2, { name: "Nope" }))
      .rejects.toMatchObject({ code: "TEMPORAL_RESOURCE_ARCHIVED", status: 409 });
    await expect(recordTemporalOccurrence(bindings(), actor, f.space, f.published, elapsed.id, 2, f.today, null))
      .rejects.toMatchObject({ code: "TEMPORAL_RESOURCE_ARCHIVED", status: 409 });
  });
});

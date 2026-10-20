import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { computeCheckIn, listCheckIns, recordCheckIn } from "../src/check-in-capability";
import { createCapabilityAwareResource } from "../src/capability-runtime";
import { addDateDays, spaceToday } from "../src/day-calculation";
import type { Bindings, Principal } from "../src/env";
import { getGenericResource, updateGenericResource } from "../src/generic-resource";
import { validateModelDefinition, type ModelDefinition } from "../src/model-definition";
import { getPublishedModel, publishModelDefinition } from "../src/model-registry";

type TestEnv = { DB: D1Database };
const bindings = (): Bindings => ({ DB: (env as unknown as TestEnv).DB } as Bindings);
const actor: Principal = {
  type: "user", id: "usr_check_in_test", clientId: "app_test_runtime",
  scopes: ["resources:read", "resources:write"], tokenId: "tok_check_in_test",
};
export const HABIT_MODEL: ModelDefinition = {
  definitionVersion: 1,
  key: "test_habit_check_in",
  description: "A durable repeating personal habit with check-in facts and computed streak.",
  display: { singular: "Habit", plural: "Habits" },
  fields: {
    name: { type: "string", title: "Name", required: true, minLength: 1, maxLength: 150 },
    description: { type: "text", title: "Notes", nullable: true, maxLength: 3000 },
    intervalDays: { type: "integer", title: "Check-in Interval", required: true, immutable: true, minimum: 1, maximum: 365 },
    lastCheckInDate: { type: "date", title: "Last Check-in", readOnly: true, nullable: true },
    streakStartDate: { type: "date", title: "Streak Start", readOnly: true, nullable: true },
  },
  defaults: { intervalDays: 1 },
  referenceLabel: { field: "name" },
  query: { searchable: ["name", "description"], filterable: ["intervalDays"], sortable: ["name"] },
  access: ["read", "write"],
  lifecycle: { optimisticConcurrency: true, softDelete: true },
  capabilities: { checkIn: {
    intervalDaysField: "intervalDays", lastCheckInDateField: "lastCheckInDate", streakStartDateField: "streakStartDate",
  } },
};

async function fixture(timezone = "Asia/Shanghai", intervalDays = 1) {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = "spc_" + suffix;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
    .bind(spaceId, "Check-in Test", actor.id, now, now, timezone).run();
  const publisher: Principal = {
    type: "service", id: "svc_check_in_test", clientId: "lifespace-platform-admin",
    scopes: ["models:manage"], tokenId: "tok_check_in_publisher",
  };
  const published = await getPublishedModel(bindings(), HABIT_MODEL.key)
    ?? await publishModelDefinition(bindings(), publisher, HABIT_MODEL, "initial");
  const resource = await createCapabilityAwareResource(bindings(), actor, spaceId, published, { name: "Read", intervalDays });
  return { db, spaceId, model: published, resource, today: spaceToday(timezone) };
}
describe("Check-in Capability", () => {
  it("validates the closed DSL and the required immutable interval/read-only state", () => {
    expect(validateModelDefinition(HABIT_MODEL).valid).toBe(true);
    const broken = structuredClone(HABIT_MODEL);
    broken.fields.intervalDays.immutable = false;
    const result = validateModelDefinition(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((v) => v.code)).toContain("INVALID_CAPABILITY_FIELD");
  });
  it("starts at zero, check-in once, is idempotent, and persists a governed Action", async () => {
    const f = await fixture();
    expect(f.resource.data.lastCheckInDate).toBeNull();
    expect(computeCheckIn(f.model, f.resource, "Asia/Shanghai").streakDays).toBe(0);
    const first = await recordCheckIn(bindings(), actor, f.spaceId, f.model, f.resource.id, 1);
    expect(first.data).toMatchObject({ lastCheckInDate: f.today, streakStartDate: f.today });
    expect(computeCheckIn(f.model, first, "Asia/Shanghai")).toMatchObject({ streakDays: 1, checkedInToday: true });
    const second = await recordCheckIn(bindings(), actor, f.spaceId, f.model, first.id, 1);
    expect(second.version).toBe(first.version);
    const history = await listCheckIns(bindings(), f.spaceId, f.model, first.id, 100);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({ checkedOn: f.today, recordedBy: { type: "user", id: actor.id } });
    const change = await f.db.prepare("SELECT action_key FROM resource_changes WHERE record_id=? AND version_after=2")
      .bind(first.id).first<{ action_key: string }>();
    expect(change?.action_key).toBe("check-in");
  });
  it("refuses client changes to state, while keeping the interval immutable", async () => {
    const f = await fixture();
    await expect(createCapabilityAwareResource(bindings(), actor, f.spaceId, f.model, {
      name: "Injected", intervalDays: 1, lastCheckInDate: f.today,
    })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(updateGenericResource(bindings(), actor, f.spaceId, f.model, f.resource.id, 1,
      { streakStartDate: f.today })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    await expect(updateGenericResource(bindings(), actor, f.spaceId, f.model, f.resource.id, 1,
      { intervalDays: 2 })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });
  it("returns zero after a lapse; a new check-in starts at one; permits interval > 1", async () => {
    const f = await fixture("Asia/Shanghai", 2);
    const past = addDateDays(f.today, -5);
    // Construct a historic projection for a bounded computation with no history scans.
    const fabricated = { ...f.resource, data: { ...f.resource.data, lastCheckInDate: past, streakStartDate: addDateDays(past, -2) } };
    expect(computeCheckIn(f.model, fabricated, "Asia/Shanghai").streakDays).toBe(0);
    const active = { ...f.resource, data: {
      ...f.resource.data, lastCheckInDate: addDateDays(f.today, -1),
      streakStartDate: addDateDays(f.today, -3),
    } };
    expect(computeCheckIn(f.model, active, "Asia/Shanghai").streakDays).toBe(3);
    const first = await recordCheckIn(bindings(), actor, f.spaceId, f.model, f.resource.id, 1);
    expect(computeCheckIn(f.model, first, "Asia/Shanghai").streakDays).toBe(1);
    expect((await getGenericResource(bindings(), f.spaceId, f.model, first.id))?.version).toBe(2);
  });
  it("provides bounded history pagination and validates cursors", async () => {
    const f = await fixture();
    await recordCheckIn(bindings(), actor, f.spaceId, f.model, f.resource.id, 1);
    const first = await listCheckIns(bindings(), f.spaceId, f.model, f.resource.id, 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeNull();
    await expect(listCheckIns(bindings(), f.spaceId, f.model, f.resource.id, 10, "bogus"))
      .rejects.toMatchObject({ code: "INVALID_QUERY" });
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createCapabilityAwareResource } from "../src/capability-runtime";
import { recordCheckIn, listCheckIns } from "../src/check-in-capability";
import { createGenericResource, updateGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";
import { requireModelPolicy } from "../src/policy";
import { executeWorkflowAction } from "../src/workflow";

type TestEnv = { DB: D1Database };
const bindings = (): Bindings => ({ DB: (env as unknown as TestEnv).DB } as Bindings);
function user(id: string): Principal {
  return { type: "user", id, clientId: "app_test_runtime",
    scopes: ["resources:read", "resources:write"], tokenId: "tok_" + id };
}
async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const id = crypto.randomUUID().replaceAll("-", "");
  const spaceId = "spc_" + id;
  const owner = user("usr_owner_" + id), helper = user("usr_helper_" + id);
  const ownerPersonId = "per_owner_" + id, helperPersonId = "per_helper_" + id;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)")
      .bind(spaceId, "Baseline Lifecycle", owner.id, now, now, "Asia/Shanghai"),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(ownerPersonId, spaceId, owner.id, "Owner", now, now),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)")
      .bind(helperPersonId, spaceId, helper.id, "Helper", now, now),
  ]);
  const goal = await getPublishedModel(bindings(), "goal");
  const habit = await getPublishedModel(bindings(), "habit");
  if (!goal || !habit) throw new Error("Schema 72 baseline models are not published");
  return { spaceId, owner, helper, ownerPersonId, helperPersonId, goal, habit };
}

describe("Goal/Habit baseline schema 72 lifecycle and owner policy", () => {
  it("governs Goal status through actions instead of PATCH", async () => {
    const f = await fixture();
    const goal = await createGenericResource(bindings(), f.owner, f.spaceId, f.goal, {
      name: "Pass the piano examination",
      subjectPersonIds: [f.ownerPersonId],
    });
    expect(goal.data.status).toBe("active");
    await expect(updateGenericResource(bindings(), f.owner, f.spaceId, f.goal, goal.id, 1, { status: "achieved" }))
      .rejects.toMatchObject({ code: "INVALID_RESOURCE" });
    const paused = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.goal, goal.id, "pause", 1);
    expect(paused.data.status).toBe("paused");
    const resumed = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.goal, goal.id, "resume", 2);
    expect(resumed.data.status).toBe("active");
    const achieved = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.goal, goal.id, "achieve", 3);
    expect(achieved.data.status).toBe("achieved");
    await expect(executeWorkflowAction(bindings(), f.owner, f.spaceId, f.goal, goal.id, "pause", 4))
      .rejects.toMatchObject({ code: "GOAL_NOT_ACTIVE" });
    const reopened = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.goal, goal.id, "reopen", 4);
    expect(reopened.data.status).toBe("active");
    const abandoned = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.goal, goal.id, "abandon", 5);
    expect(abandoned.data.status).toBe("abandoned");
  });

  it("allows someone to create a Habit for another Person, but only that Person may mutate or check in", async () => {
    const f = await fixture();
    const habit = await createCapabilityAwareResource(bindings(), f.helper, f.spaceId, f.habit, {
      name: "Daily reading", subjectPersonId: f.ownerPersonId,
    });
    expect(habit.data).toMatchObject({ subjectPersonId: f.ownerPersonId, status: "active", intervalDays: 1 });
    // Read remains available to all otherwise-authorized family members.
    await expect(requireModelPolicy(bindings(), f.helper, f.spaceId, f.habit, "read", habit)).resolves.toBeDefined();
    await expect(requireModelPolicy(bindings(), f.helper, f.spaceId, f.habit, "update", habit, { name: "Hijack" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });
    await expect(requireModelPolicy(bindings(), f.helper, f.spaceId, f.habit, "delete", habit))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });
    await expect(executeWorkflowAction(bindings(), f.helper, f.spaceId, f.habit, habit.id, "pause", habit.version))
      .rejects.toMatchObject({ code: "POLICY_DENIED", status: 403 });
    await expect(requireModelPolicy(bindings(), f.owner, f.spaceId, f.habit, "update", habit, {}))
      .resolves.toBeDefined();
    const checked = await recordCheckIn(bindings(), f.owner, f.spaceId, f.habit, habit.id, habit.version);
    expect(checked.data.lastCheckInDate).toBeTruthy();
    const paused = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.habit, habit.id, "pause", checked.version);
    expect(paused.data.status).toBe("paused");
    await expect(recordCheckIn(bindings(), f.owner, f.spaceId, f.habit, habit.id, paused.version))
      .rejects.toMatchObject({ code: "CHECK_IN_INACTIVE" });
    const resumed = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.habit, habit.id, "resume", paused.version);
    expect(resumed.data.status).toBe("active");
    const ended = await executeWorkflowAction(bindings(), f.owner, f.spaceId, f.habit, habit.id, "end", resumed.version);
    await expect(recordCheckIn(bindings(), f.owner, f.spaceId, f.habit, habit.id, ended.version))
      .rejects.toMatchObject({ code: "CHECK_IN_INACTIVE" });
    const historical = await listCheckIns(bindings(), f.spaceId, f.habit, habit.id, 100);
    expect(historical.items).toHaveLength(1);
  });

  it("denies a principal without a linked Space Person even if a record has no owner", async () => {
    const f = await fixture();
    const anonymousService = {
      type: "service", id: "svc_no_person", clientId: "app_test_runtime",
      tokenId: "tok_service", scopes: ["resources:read", "resources:write"],
    } as Principal;
    const habit = await createCapabilityAwareResource(bindings(), f.owner, f.spaceId, f.habit, {
      name: "Practice", subjectPersonId: f.ownerPersonId,
    });
    await expect(requireModelPolicy(bindings(), anonymousService, f.spaceId, f.habit, "update", habit, {}))
      .rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
});

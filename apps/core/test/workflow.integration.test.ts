import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";
import { executeWorkflowAction } from "../src/workflow";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const creator: Principal = {
  type: "user",
  id: "usr_workflow_creator",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_workflow_creator",
};

const serviceActor: Principal = {
  type: "service",
  id: "svc_workflow_executor",
  clientId: "homemew-integration",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_workflow_service",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
    VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Workflow Test", creator.id, now, now, "UTC").run();
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  const resource = await createGenericResource(bindings(), creator, spaceId, model, {
    name: "Ship workflow",
    status: "pending",
    assigneePersonIds: [],
  });
  return { db, spaceId, model, resource };
}

describe("Generic Workflow Engine", () => {
  it("executes Task complete/reopen from published metadata for a service Actor", async () => {
    const { db, spaceId, model, resource } = await fixture();

    const completed = await executeWorkflowAction(bindings(), serviceActor, spaceId, model, resource.id, "complete", 1);
    expect(completed.version).toBe(2);
    expect(completed.data.status).toBe("completed");
    expect(completed.data.completedByType).toBe("service");
    expect(completed.data.completedById).toBe(serviceActor.id);
    expect(typeof completed.data.completedAt).toBe("string");
    expect(Number.isNaN(Date.parse(completed.data.completedAt as string))).toBe(false);

    const typed = await db.prepare(`SELECT status,completedByType,completedById,completedAt FROM mdl_task WHERE record_id=?`)
      .bind(resource.id).first<{ status: string; completedByType: string; completedById: string; completedAt: string }>();
    expect(typed?.status).toBe("completed");
    expect(typed?.completedByType).toBe("service");
    expect(typed?.completedById).toBe(serviceActor.id);
    expect(typed?.completedAt).toBe(completed.data.completedAt);

    await expect(executeWorkflowAction(bindings(), serviceActor, spaceId, model, resource.id, "complete", 2))
      .rejects.toMatchObject({ code: "TASK_ALREADY_COMPLETED", status: 409 });

    const reopened = await executeWorkflowAction(bindings(), creator, spaceId, model, resource.id, "reopen", 2);
    expect(reopened.version).toBe(3);
    expect(reopened.data.status).toBe("pending");
    expect(reopened.data.completedAt).toBeNull();
    expect(reopened.data.completedByType).toBeNull();
    expect(reopened.data.completedById).toBeNull();
  });

  it("records a direct user as the Task completion Actor", async () => {
    const { spaceId, model, resource } = await fixture();
    const completed = await executeWorkflowAction(bindings(), creator, spaceId, model, resource.id, "complete", 1);
    expect(completed.data).toMatchObject({
      status: "completed",
      completedByType: "user",
      completedById: creator.id,
    });
  });

  it("rejects stale versions before evaluating workflow guards", async () => {
    const { spaceId, model, resource } = await fixture();
    await executeWorkflowAction(bindings(), creator, spaceId, model, resource.id, "complete", 1);
    await expect(executeWorkflowAction(bindings(), creator, spaceId, model, resource.id, "reopen", 1))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });
});

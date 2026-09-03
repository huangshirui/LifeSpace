import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource } from "../src/generic-resource";
import { queryGenericResources } from "../src/generic-query";
import { getPublishedModel } from "../src/model-registry";
import { executeWorkflowAction } from "../src/workflow";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_generic_query_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_generic_query_test",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const personId = `per_${suffix}`;
  const otherPersonId = `per_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Query Test", actor.id, now, now, "UTC"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, actor.id, "Tester", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(otherPersonId, spaceId, null, "Other", now, now),
  ]);
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  const first = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Buy milk",
    description: "Remember oat milk",
    dueDate: "2026-08-12",
    assigneePersonIds: [personId],
  });
  const secondCreated = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Book field",
    description: "Saturday football",
    dueDate: "2026-08-13",
    assigneePersonIds: [otherPersonId],
  });
  const second = await executeWorkflowAction(bindings(), actor, spaceId, model, secondCreated.id, "complete", 1);
  const third = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Call school",
    description: "Ask about timetable",
    dueDate: "2026-08-14",
    assigneePersonIds: [personId],
  });
  const noDueCreated = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Someday",
    assigneePersonIds: [],
  });
  const noDue = await executeWorkflowAction(bindings(), actor, spaceId, model, noDueCreated.id, "cancel", 1);
  return { spaceId, personId, model, first, second, third, noDue };
}

describe("Generic Query Engine", () => {
  it("searches declared text fields and filters enum/date/relation metadata", async () => {
    const { spaceId, personId, model, first, third } = await fixture();

    const search = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ q: "oat milk" }));
    expect(search.items.map((item) => item.id)).toEqual([first.id]);

    const pending = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ status: "pending" }));
    expect(new Set(pending.items.map((item) => item.id))).toEqual(new Set([first.id, third.id]));

    const range = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ dueDateFrom: "2026-08-13", dueDateTo: "2026-08-14" }));
    expect(range.items).toHaveLength(2);

    const assigned = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ assigneePersonIds: personId }));
    expect(new Set(assigned.items.map((item) => item.id))).toEqual(new Set([first.id, third.id]));
  });

  it("paginates declared sorts with stable cursor binding and nulls last", async () => {
    const { spaceId, model, first, second, third, noDue } = await fixture();
    const page1 = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ sort: "dueDate:asc", limit: "2" }));
    expect(page1.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ sort: "dueDate:asc", limit: "2", cursor: page1.nextCursor! }));
    expect(page2.items.map((item) => item.id)).toEqual([third.id, noDue.id]);
    expect(page2.nextCursor).toBeNull();

    await expect(queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ sort: "name:asc", cursor: page1.nextCursor! })))
      .rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("rejects undeclared query parameters", async () => {
    const { spaceId, model } = await fixture();
    await expect(queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ secretField: "x" })))
      .rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });
  });
});

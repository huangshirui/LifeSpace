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
  clientId: "app_test_runtime",
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
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)`).bind(spaceId, "Query Test", actor.id, now, now, "UTC"),
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
  const sameDue = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Zoo appointment",
    description: "Same due date as field booking",
    dueDate: "2026-08-13",
    assigneePersonIds: [],
  });
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
  const noDueOther = await createGenericResource(bindings(), actor, spaceId, model, {
    name: "Another someday",
    assigneePersonIds: [],
  });
  return { spaceId, personId, model, first, second, sameDue, third, noDue, noDueOther };
}

function orderedParams(entries: Array<[string, string]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  return params;
}

describe("Generic Query Engine", () => {
  it("searches declared text fields and filters enum/date/relation metadata", async () => {
    const { spaceId, personId, model, first, sameDue, third, noDueOther } = await fixture();

    const search = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ q: "oat milk" }));
    expect(search.items.map((item) => item.id)).toEqual([first.id]);

    const pending = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ status: "pending" }));
    expect(new Set(pending.items.map((item) => item.id))).toEqual(new Set([first.id, sameDue.id, third.id, noDueOther.id]));

    const range = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ dueDateFrom: "2026-08-13", dueDateTo: "2026-08-14" }));
    expect(range.items).toHaveLength(3);

    const assigned = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ assigneePersonIds: personId }));
    expect(new Set(assigned.items.map((item) => item.id))).toEqual(new Set([first.id, third.id]));
  });

  it("paginates single-field declared sorts with stable cursor binding and nulls last", async () => {
    const { spaceId, model, first, second, sameDue, third, noDue, noDueOther } = await fixture();
    const page1 = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ sort: "dueDate:asc", limit: "1" }));
    expect(page1.items.map((item) => item.id)).toEqual([first.id]);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ sort: "dueDate:asc", limit: "5", cursor: page1.nextCursor! }));
    expect(new Set(page2.items.map((item) => item.id))).toEqual(new Set([second.id, sameDue.id, third.id, noDue.id, noDueOther.id]));
    expect(page2.items.slice(-2).every((item) => item.data.dueDate == null)).toBe(true);
    expect(page2.nextCursor).toBeNull();

    await expect(queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ sort: "name:asc", cursor: page1.nextCursor! })))
      .rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("supports ordered multi-field sort with mixed directions, nulls last and tuple cursor continuation", async () => {
    const { spaceId, model, first, second, sameDue, third, noDue, noDueOther } = await fixture();
    const expected = [first.id, sameDue.id, second.id, third.id, noDue.id, noDueOther.id];

    const firstParams = orderedParams([
      ["sort", "dueDate:asc"],
      ["sort", "name:desc"],
      ["limit", "2"],
    ]);
    const page1 = await queryGenericResources(bindings(), spaceId, model, firstParams);
    expect(page1.items.map((item) => item.id)).toEqual(expected.slice(0, 2));
    expect(page1.nextCursor).toBeTruthy();

    const secondParams = orderedParams([
      ["sort", "dueDate:asc"],
      ["sort", "name:desc"],
      ["limit", "2"],
      ["cursor", page1.nextCursor!],
    ]);
    const page2 = await queryGenericResources(bindings(), spaceId, model, secondParams);
    expect(page2.items.map((item) => item.id)).toEqual(expected.slice(2, 4));
    expect(page2.nextCursor).toBeTruthy();

    const thirdParams = orderedParams([
      ["sort", "dueDate:asc"],
      ["sort", "name:desc"],
      ["limit", "2"],
      ["cursor", page2.nextCursor!],
    ]);
    const page3 = await queryGenericResources(bindings(), spaceId, model, thirdParams);
    expect(page3.items.map((item) => item.id)).toEqual(expected.slice(4));
    expect(page3.nextCursor).toBeNull();

    const reordered = orderedParams([
      ["sort", "name:desc"],
      ["sort", "dueDate:asc"],
      ["cursor", page1.nextCursor!],
    ]);
    await expect(queryGenericResources(bindings(), spaceId, model, reordered))
      .rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("rejects duplicate, unsupported and excessive ordered sort criteria", async () => {
    const { spaceId, model } = await fixture();

    await expect(queryGenericResources(bindings(), spaceId, model, orderedParams([
      ["sort", "dueDate:asc"],
      ["sort", "dueDate:desc"],
    ]))).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });

    await expect(queryGenericResources(bindings(), spaceId, model, orderedParams([
      ["sort", "status:asc"],
      ["sort", "name:asc"],
    ]))).rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });

    const excessive = new URLSearchParams();
    for (let index = 0; index < 9; index += 1) excessive.append("sort", index % 2 ? "name:asc" : "dueDate:asc");
    await expect(queryGenericResources(bindings(), spaceId, model, excessive))
      .rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });
  });

  it("rejects undeclared query parameters", async () => {
    const { spaceId, model } = await fixture();
    await expect(queryGenericResources(bindings(), spaceId, model, new URLSearchParams({ secretField: "x" })))
      .rejects.toMatchObject({ code: "INVALID_QUERY", status: 400 });
  });
});

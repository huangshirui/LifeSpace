import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import {
  createGenericResource,
  deleteGenericResource,
  getGenericResource,
  listGenericResources,
  updateGenericResource,
} from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_generic_resource_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_generic_resource_test",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const personId = `per_${suffix}`;
  const otherSpaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
  const otherPersonId = `per_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Generic Runtime Test", actor.id, now, now, "Asia/Shanghai"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(personId, spaceId, actor.id, "Tester", now, now),
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(otherSpaceId, "family", "Other Space", actor.id, now, now, "UTC"),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(otherPersonId, otherSpaceId, null, "Other", now, now),
  ]);
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  return { db, spaceId, personId, otherPersonId, model };
}

describe("Generic Resource Runtime", () => {
  it("creates and reads a Task from its generated typed table", async () => {
    const { db, spaceId, personId, model } = await fixture();
    const resource = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Buy milk",
      description: "2 bottles",
      dueDate: "2026-08-12",
      status: "pending",
      assigneePersonIds: [personId],
    });

    expect(resource.modelKey).toBe("task");
    expect(resource.modelVersion).toBe(2);
    expect(resource.version).toBe(1);
    expect(resource.data).toMatchObject({ name: "Buy milk", status: "pending", assigneePersonIds: [personId] });

    const relation = await db.prepare(`SELECT target_type,target_person_id FROM resource_relations
      WHERE source_record_id=? AND field_key='assigneePersonIds'`).bind(resource.id).first<{ target_type: string; target_person_id: string }>();
    expect(relation).toEqual({ target_type: "person", target_person_id: personId });

    const typed = await db.prepare(`SELECT name,status,dueDate FROM mdl_task WHERE record_id=?`)
      .bind(resource.id).first<{ name: string; status: string; dueDate: string }>();
    expect(typed).toEqual({ name: "Buy milk", status: "pending", dueDate: "2026-08-12" });

    const envelope = await db.prepare("SELECT data_json FROM resource_records WHERE id=?")
      .bind(resource.id).first<{ data_json: string }>();
    expect(envelope?.data_json).toBe("{}");
    const indexCount = await db.prepare("SELECT count(*) AS count FROM resource_index_values WHERE record_id=?")
      .bind(resource.id).first<{ count: number }>();
    expect(indexCount?.count).toBe(0);
  });

  it("enforces declared schema and read-only fields", async () => {
    const { spaceId, model } = await fixture();
    await expect(createGenericResource(bindings(), actor, spaceId, model, {
      name: "Invalid",
      status: "pending",
      unknownField: true,
    })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });

    await expect(createGenericResource(bindings(), actor, spaceId, model, {
      name: "Invalid",
      status: "pending",
      completedAt: new Date().toISOString(),
    })).rejects.toMatchObject({ code: "INVALID_RESOURCE" });
  });

  it("enforces same-Space active Person relations", async () => {
    const { spaceId, otherPersonId, model } = await fixture();
    await expect(createGenericResource(bindings(), actor, spaceId, model, {
      name: "Cross-space relation",
      status: "pending",
      assigneePersonIds: [otherPersonId],
    })).rejects.toMatchObject({ code: "INVALID_RESOURCE_RELATION" });
  });

  it("updates typed fields with optimistic concurrency and refreshes relations", async () => {
    const { db, spaceId, personId, model } = await fixture();
    const resource = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Initial",
      status: "pending",
      assigneePersonIds: [personId],
    });

    const updated = await updateGenericResource(bindings(), actor, spaceId, model, resource.id, 1, {
      name: "Updated",
      status: "cancelled",
      assigneePersonIds: [],
    });
    expect(updated.version).toBe(2);
    expect(updated.data).toMatchObject({ name: "Updated", status: "cancelled", assigneePersonIds: [] });

    const typed = await db.prepare("SELECT name,status FROM mdl_task WHERE record_id=?")
      .bind(resource.id).first<{ name: string; status: string }>();
    expect(typed).toEqual({ name: "Updated", status: "cancelled" });

    const relationCount = await db.prepare("SELECT count(*) AS count FROM resource_relations WHERE source_record_id=?")
      .bind(resource.id).first<{ count: number }>();
    expect(relationCount?.count).toBe(0);

    await expect(updateGenericResource(bindings(), actor, spaceId, model, resource.id, 1, { name: "Stale" }))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("soft-deletes resources and removes relation projections", async () => {
    const { db, spaceId, personId, model } = await fixture();
    const resource = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Delete me",
      dueDate: "2026-08-13",
      status: "pending",
      assigneePersonIds: [personId],
    });

    await deleteGenericResource(bindings(), actor, spaceId, model, resource.id, 1);
    expect(await getGenericResource(bindings(), spaceId, model, resource.id)).toBeNull();
    expect((await listGenericResources(bindings(), spaceId, model)).some((item) => item.id === resource.id)).toBe(false);

    const relationCount = await db.prepare("SELECT count(*) AS count FROM resource_relations WHERE source_record_id=?")
      .bind(resource.id).first<{ count: number }>();
    expect(relationCount?.count).toBe(0);
  });
});

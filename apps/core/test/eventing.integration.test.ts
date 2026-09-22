import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings, Principal } from "../src/env";
import { createGenericResource, deleteGenericResource, updateGenericResource } from "../src/generic-resource";
import { getPublishedModel } from "../src/model-registry";

type TestEnv = { DB: D1Database };

function bindings(): Bindings {
  return { DB: (env as unknown as TestEnv).DB } as Bindings;
}

const actor: Principal = {
  type: "user",
  id: "usr_eventing_test",
  clientId: "homemew-miniprogram",
  scopes: ["resources:read", "resources:write"],
  tokenId: "tok_eventing_test",
};

async function fixture() {
  const db = (env as unknown as TestEnv).DB;
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
    VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "family", "Eventing Test", actor.id, now, now, "Asia/Shanghai").run();
  const model = await getPublishedModel(bindings(), "task");
  if (!model) throw new Error("bootstrap Task model is missing");
  return { db, spaceId, model };
}

describe("Domain Event outbox", () => {
  it("emits one model-agnostic event for create, update and delete", async () => {
    const { db, spaceId, model } = await fixture();
    const created = await createGenericResource(bindings(), actor, spaceId, model, {
      name: "Eventing task",
    });
    await updateGenericResource(bindings(), actor, spaceId, model, created.id, 1, {
      name: "Updated eventing task",
    });
    await deleteGenericResource(bindings(), actor, spaceId, model, created.id, 2);

    const rows = await db.prepare(`SELECT event_type,space_id,model_key,record_id,record_version,change_id,actor_type,actor_id
      FROM domain_event_outbox WHERE record_id=? ORDER BY record_version,event_type`)
      .bind(created.id)
      .all<{
        event_type: string;
        space_id: string;
        model_key: string;
        record_id: string;
        record_version: number;
        change_id: string | null;
        actor_type: string;
        actor_id: string;
      }>();

    const changeRows = await db.prepare("SELECT id,version_after FROM resource_changes WHERE record_id=? ORDER BY version_after")
      .bind(created.id).all<{ id: string; version_after: number }>();
    expect(rows.results.map((row) => row.change_id)).toEqual(changeRows.results.map((row) => row.id));
    expect(rows.results.map(({ change_id: _changeId, ...row }) => row)).toEqual([
      {
        event_type: "record.created",
        space_id: spaceId,
        model_key: "task",
        record_id: created.id,
        record_version: 1,
        actor_type: "user",
        actor_id: actor.id,
      },
      {
        event_type: "record.updated",
        space_id: spaceId,
        model_key: "task",
        record_id: created.id,
        record_version: 2,
        actor_type: "user",
        actor_id: actor.id,
      },
      {
        event_type: "record.deleted",
        space_id: spaceId,
        model_key: "task",
        record_id: created.id,
        record_version: 3,
        actor_type: "user",
        actor_id: actor.id,
      },
    ]);
  });
});

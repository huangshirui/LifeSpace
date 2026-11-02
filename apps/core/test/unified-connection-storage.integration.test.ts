import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

type Row = {
  id: string; application_id: string; space_id: string;
  kind: string; name: string; note: string | null; status: string;
  owner_type: string; owner_id: string;
  identity_type: string | null; identity_id: string | null;
  backing_type: string | null; backing_id: string | null;
  created_at: string; updated_at: string; revoked_at: string | null;
};

const db = () => (env as unknown as { DB: D1Database }).DB;
const random = () => crypto.randomUUID().replaceAll("-", "");

async function setup() {
  const suffix = random();
  const spaceId = `spc_${suffix}`;
  const userId = `usr_${suffix}`;
  const applicationId = `app_${suffix}`;
  const time = new Date().toISOString();
  await db().prepare(
    "INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?)",
  ).bind(spaceId, "Synthetic Connection", userId, time, time).run();
  return { suffix, spaceId, userId, applicationId, time };
}

async function create(
  ctx: Awaited<ReturnType<typeof setup>>,
  kind: Row["kind"],
  overrides: Record<string, unknown> = {},
) {
  const fields: Record<string, unknown> = {
    id: `conn_${random()}`,
    application_id: ctx.applicationId,
    space_id: ctx.spaceId,
    kind,
    name: "Synthetic integration",
    note: null,
    status: "pending",
    owner_type: "space",
    owner_id: ctx.spaceId,
    identity_type: null,
    identity_id: null,
    backing_type: null,
    backing_id: null,
    created_at: ctx.time,
    updated_at: ctx.time,
    revoked_at: null,
    ...overrides,
  };
  const columns = Object.keys(fields);
  await db().prepare(
    `INSERT INTO unified_connections(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
  ).bind(...Object.values(fields)).run();
  return fields.id as string;
}
const row = (id: string) =>
  db().prepare("SELECT * FROM unified_connections WHERE id=?").bind(id).first<Row>();

describe("unified Connection metadata persistence — no public routes", () => {
  it("stores a pending connection with note and a unique dedicated service identity", async () => {
    const ctx = await setup();
    const sid = `svc_${random()}`;
    const first = await create(ctx, "service", { note: "This is a user note" });
    expect((await row(first))?.status).toBe("pending");
    expect((await row(first))?.note).toBe("This is a user note");
    await db().prepare("UPDATE unified_connections SET identity_type='service',identity_id=? WHERE id=?")
      .bind(sid, first).run();
    await db().prepare("UPDATE unified_connections SET status='active' WHERE id=?").bind(first).run();
    expect((await row(first))?.identity_id).toBe(sid);
    await expect(create(ctx, "service", { identity_type: "service", identity_id: sid })).rejects.toThrow();
    // An active Agent or Service cannot be represented with no identity.
    await expect(create(ctx, "agent", { status: "active" })).rejects.toThrow();
  });

  it("prevents moving a connection between Applications, Spaces, owners, kinds or identities", async () => {
    const ctx = await setup();
    const id = await create(ctx, "agent", {
      owner_type: "user", owner_id: ctx.userId,
      identity_type: "agent", identity_id: `agt_${random()}`,
    });
    const changes = [
      ["application_id", `app_${random()}`],
      ["space_id", `spc_${random()}`],
      ["kind", "service"],
      ["owner_id", `usr_${random()}`],
      ["identity_id", `agt_${random()}`],
    ] as const;
    for (const [column, value] of changes) {
      await expect(db().prepare(`UPDATE unified_connections SET ${column}=? WHERE id=?`).bind(value, id).run())
        .rejects.toThrow();
    }
    expect((await row(id))?.kind).toBe("agent");
  });

  it("revocation is terminal and a revoked connection cannot be reactivated", async () => {
    const ctx = await setup();
    const id = await create(ctx, "service", {
      identity_type: "service", identity_id: `svc_${random()}`,
    });
    await db().prepare("UPDATE unified_connections SET status='active' WHERE id=?").bind(id).run();
    await db().prepare("UPDATE unified_connections SET status='revoked',revoked_at=? WHERE id=?")
      .bind(ctx.time, id).run();
    expect((await row(id))?.status).toBe("revoked");
    await expect(db().prepare("UPDATE unified_connections SET status='active',revoked_at=NULL WHERE id=?")
      .bind(id).run()).rejects.toThrow();
  });

  it("only Event Push and External Data have matching and exclusively owned backing references", async () => {
    const ctx = await setup();
    const endpointId = `whk_${random()}`;
    const eventPush = await create(ctx, "event_push", {
      backing_type: "webhook_endpoint", backing_id: endpointId,
    });
    await db().prepare("UPDATE unified_connections SET status='active' WHERE id=?").bind(eventPush).run();
    await expect(create(ctx, "event_push", {
      backing_type: "webhook_endpoint", backing_id: endpointId,
    })).rejects.toThrow();
    await expect(create(ctx, "event_push", {
      identity_type: "service", identity_id: `svc_${random()}`,
    })).rejects.toThrow();
    await expect(create(ctx, "external_data", {
      backing_type: "webhook_endpoint", backing_id: `whk_${random()}`,
    })).rejects.toThrow();
    await expect(create(ctx, "external_data", { status: "active" })).rejects.toThrow();
    const external = await create(ctx, "external_data", {
      backing_type: "external_provider", backing_id: `cnx_${random()}`,
    });
    expect((await row(external))?.backing_type).toBe("external_provider");
  });

  it("does not persist credentials or data grants in the Connection table", async () => {
    const cols = await db().prepare("PRAGMA table_info(unified_connections)").all<{ name: string }>();
    const names = cols.results.map(x => x.name);
    expect(names).toContain("note");
    for (const forbidden of ["credential", "credential_ref", "token", "secret", "grant_id", "delegation_id"]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

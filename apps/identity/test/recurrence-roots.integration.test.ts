import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";

describe("Current enrolled Recurrence identity projection", () => {
  it("authenticates the internal caller; intersects current application/principal ceilings and rejects disabled roots", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const suffix = crypto.randomUUID().replaceAll("-", ""), app = `app_${suffix}`, user = `usr_${suffix}`, service = `svc_${suffix}`, agent = `agt_${suffix}`;
    const timestamp = new Date().toISOString();
    await db.batch([
      db.prepare("INSERT INTO applications(id,name,allowed_scopes,status,created_at,updated_at) VALUES(?,'Recurrence',?,'active',?,?)").bind(app, JSON.stringify(["resources:read", "resources:write"]), timestamp, timestamp),
      db.prepare("INSERT INTO users(id,display_name,created_at,updated_at) VALUES(?,'User',?,?)").bind(user, timestamp, timestamp),
      db.prepare("INSERT INTO service_principals(id,application_id,display_name,max_scopes,status,created_at,updated_at) VALUES(?,?,'Service',?,'active',?,?)").bind(service, app, JSON.stringify(["resources:read"]), timestamp, timestamp),
      db.prepare("INSERT INTO agents(id,display_name,created_at,updated_at) VALUES(?,'Agent',?,?)").bind(agent, timestamp, timestamp),
      db.prepare("INSERT INTO agent_applications(agent_id,application_id,created_at) VALUES(?,?,?)").bind(agent, app, timestamp),
    ]);
    const roots = [{ type: "user", id: user, applicationId: app }, { type: "service", id: service, applicationId: app }, { type: "agent", id: agent, applicationId: app }];
    const request = (secret = "internal-test") => createIdentityApp().request("http://identity.test/introspection/v1/recurrence-roots", { method: "POST", headers: { "content-type": "application/json", "x-lifespace-internal-secret": secret }, body: JSON.stringify({ roots }) }, { DB: db, CORE_IDENTITY_SHARED_SECRET: "internal-test", ENVIRONMENT: "test" });
    expect((await request("wrong")).status).toBe(401);
    const result = await (await request()).json<any>();
    expect(result.data.roots.map((root: any) => root.active)).toEqual([true, true, true]);
    expect(result.data.roots[1].scopes).toEqual(["resources:read"]);
    await db.prepare("UPDATE agent_applications SET status='revoked' WHERE agent_id=?").bind(agent).run();
    expect((await (await request()).json<any>()).data.roots[2].active).toBe(false);
    await db.prepare("UPDATE applications SET status='disabled' WHERE id=?").bind(app).run();
    expect((await (await request()).json<any>()).data.roots.every((root: any) => !root.active)).toBe(true);
  });
  it("rejects missing or unbounded input", async () => {
    const db = (env as unknown as { DB: D1Database }).DB;
    const response = await createIdentityApp().request("http://identity.test/introspection/v1/recurrence-roots", { method: "POST", headers: { "content-type": "application/json", "x-lifespace-internal-secret": "internal-test" }, body: JSON.stringify({ roots: Array.from({ length: 41 }, () => ({ type: "user", id: "usr_test", applicationId: "app_test" })) }) }, { DB: db, CORE_IDENTITY_SHARED_SECRET: "internal-test", ENVIRONMENT: "test" });
    expect(response.status).toBe(400);
  });
});

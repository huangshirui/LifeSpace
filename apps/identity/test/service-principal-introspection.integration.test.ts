import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createIdentityApp } from "../src/index";

type TestEnv = { DB: D1Database; ASSETS: R2Bucket };

function bindings() {
  const test = env as unknown as TestEnv;
  return {
    DB: test.DB,
    ASSETS: test.ASSETS,
    CORE_IDENTITY_SHARED_SECRET: "test-core-identity-shared-secret-at-least-32",
    ENVIRONMENT: "test",
  };
}

async function fixture() {
  const b = bindings();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const applicationId = `app_introspection_${suffix}`;
  const principalId = `svc_${suffix}`;
  const timestamp = new Date().toISOString();
  await b.DB.batch([
    b.DB.prepare(`INSERT INTO applications(id,name,client_type,allowed_scopes,status,created_at,updated_at)
      VALUES(?,?,'service','[]','active',?,?)`).bind(applicationId, "Introspection test", timestamp, timestamp),
    b.DB.prepare(`INSERT INTO service_principals(id,application_id,display_name,max_scopes,status,created_at,updated_at)
      VALUES(?,?,?,'[]','active',?,?)`).bind(principalId, applicationId, "Webhook subscriber", timestamp, timestamp),
  ]);
  return { app: createIdentityApp(), b, applicationId, principalId };
}

async function introspect(
  app: ReturnType<typeof createIdentityApp>,
  b: ReturnType<typeof bindings>,
  principalId: string,
  secret = b.CORE_IDENTITY_SHARED_SECRET,
) {
  return app.request(`http://identity.test/introspection/v1/service-principals/${encodeURIComponent(principalId)}`, {
    headers: { "x-lifespace-internal-secret": secret },
  }, b);
}

describe("Service principal current-state introspection", () => {
  it("reports only principals with an active principal and active owning application as eligible", async () => {
    const { app, b, applicationId, principalId } = await fixture();

    const active = await introspect(app, b, principalId);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ data: { active: true } });

    await b.DB.prepare("UPDATE service_principals SET status='disabled',disabled_at=?,updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), new Date().toISOString(), principalId).run();
    expect(await (await introspect(app, b, principalId)).json()).toEqual({ data: { active: false } });

    await b.DB.prepare("UPDATE service_principals SET status='active',disabled_at=NULL,updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), principalId).run();
    await b.DB.prepare("UPDATE applications SET status='disabled',updated_at=? WHERE id=?")
      .bind(new Date().toISOString(), applicationId).run();
    expect(await (await introspect(app, b, principalId)).json()).toEqual({ data: { active: false } });

    expect(await (await introspect(app, b, `svc_${crypto.randomUUID().replaceAll("-", "")}`)).json())
      .toEqual({ data: { active: false } });
  });

  it("requires the Core/Identity internal service secret", async () => {
    const { app, b, principalId } = await fixture();
    const denied = await introspect(app, b, principalId, "wrong-secret");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });
});

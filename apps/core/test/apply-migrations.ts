import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { vi } from "vitest";
import { activeServicePrincipalIdentityBindings } from "./support/service-principal-identity";

vi.mock("../src/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/app")>();
  return {
    ...actual,
    createApp() {
      const app = actual.createApp();
      const originalRequest = app.request.bind(app);
      app.request = ((...args: Parameters<typeof app.request>) => {
        const [input, requestInit, bindings, executionCtx] = args;
        return originalRequest(
          input,
          requestInit,
          {
            ...activeServicePrincipalIdentityBindings(),
            ...(bindings ?? {}),
          },
          executionCtx,
        );
      }) as typeof app.request;
      return app;
    },
  };
});

const testDb = (env as unknown as { DB: D1Database }).DB;

await applyD1Migrations(
  testDb,
  (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
);

// Generic Runtime tests use an anonymous Application fixture rather than
// borrowing any concrete downstream application's production catalog seed.
await testDb.batch(
  ["task", "wish", "day_record", "event", "person_group"].map((modelKey) =>
    testDb.prepare(`INSERT OR REPLACE INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind("app_test_runtime", modelKey, "write", "service", "svc_test_bootstrap"),
  ),
);

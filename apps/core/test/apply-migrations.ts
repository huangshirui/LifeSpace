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

await applyD1Migrations(
  (env as unknown as { DB: D1Database }).DB,
  (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS,
);

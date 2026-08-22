import { createApp } from "./app";
import { registerAccessIdentityRoutes } from "./access-identity";

export { createApp } from "./app";
export type { Bindings } from "./env";

export function createIdentityApp(options: Parameters<typeof registerAccessIdentityRoutes>[1] = {}) {
  const app = createApp();
  registerAccessIdentityRoutes(app, options);
  return app;
}

export default createIdentityApp();

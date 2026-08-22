import { createApp } from "./app";
import { registerAccessIdentityRoutes } from "./access-identity";
import { registerPlatformInspectorRoutes } from "./platform-inspector";

export { createApp } from "./app";
export type { Bindings } from "./env";

export function createIdentityApp(options: Parameters<typeof registerAccessIdentityRoutes>[1] = {}) {
  const app = createApp();
  registerAccessIdentityRoutes(app, options);
  registerPlatformInspectorRoutes(app);
  return app;
}

export default createIdentityApp();

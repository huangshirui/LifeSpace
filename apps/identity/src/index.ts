import { createApp } from "./app";
import { registerAccessIdentityRoutes } from "./access-identity";
import { registerPlatformAdminActorRoutes } from "./platform-admin-actor";
import { registerPlatformAdminAssignmentRoutes } from "./platform-admin-assignment";
import { registerPlatformInspectorRoutes } from "./platform-inspector";

export { createApp } from "./app";
export type { Bindings } from "./env";

export function createIdentityApp(options: Parameters<typeof registerAccessIdentityRoutes>[1] = {}) {
  const app = createApp();
  registerAccessIdentityRoutes(app, options);
  registerPlatformAdminActorRoutes(app);
  registerPlatformAdminAssignmentRoutes(app);
  registerPlatformInspectorRoutes(app);
  return app;
}

export default createIdentityApp();

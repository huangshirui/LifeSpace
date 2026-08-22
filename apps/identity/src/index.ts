import { createApp } from "./app";
import { registerAccessIdentityRoutes, type AccessRouteOptions } from "./access-identity";

export { createApp } from "./app";
export type { Bindings } from "./env";

export function createIdentityApp(options: AccessRouteOptions = {}) {
  const app = createApp();
  registerAccessIdentityRoutes(app, options);
  return app;
}

export default createIdentityApp();

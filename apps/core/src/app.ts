import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings, Variables } from "./env";
import { authenticate } from "./auth";
import { registerAgentDelegationRoutes } from "./agent-delegation";
import { registerChangeHistoryRoutes } from "./change-history";
import { registerRegistryCreationDraftRoutes } from "./registry-creation-draft-jobs";
import { registerGenericResourceRoutes } from "./generic-resource-routes";
import { registerRuntimeDiscoveryRoutes } from "./runtime-discovery";
import { registerRuntimeModelSemanticDetailRoutes } from "./runtime-model-semantic-detail";
import { registerRelationTargetRoutes } from "./relation-targets";
import { registerEventSubscriptionRoutes } from "./event-subscription-routes";
import { ApiError, failure, success } from "./http";
import { registerModelAdminRoutes } from "./model-admin";
import { registerModelAdminAiRoutes } from "./model-admin-ai";
import { registerPlatformAdminRoutes } from "./platform-admin";
import { registerPlatformInspectorRoutes } from "./platform-inspector";
import { registerSpaceRoutes } from "./spaces";
import { registerSpaceLifecycleRoutes } from "./space-lifecycle";
import { registerSpaceAvatarRoutes } from "./space-avatars";
import { registerGrantRoutes } from "./grants";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const defaultOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
function origins(env: Bindings) { return env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean) : defaultOrigins; }
async function schemaVersion(env: Bindings) {
  const row = await env.DB.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").first<{ value: string }>();
  if (!row) throw new Error("schema version metadata is missing");
  return row.value;
}

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id")?.trim() || crypto.randomUUID();
    context.set("requestId", requestId);
    await next();
    context.header("x-request-id", requestId);
  });
  app.use("*", cors({
    origin: (origin, context) => origins(context.env).includes(origin) ? origin : undefined,
    allowHeaders: ["Authorization", "Content-Type", "X-Request-ID", "X-LifeSpace-Actor-Token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }));
  app.get("/health", (context) => context.json(success({ status: "ok" })));
  app.get("/api/v1/status", async (context) => context.json(success({
    status: "ok", service: "core", environment: context.env.ENVIRONMENT ?? "local", database: "available",
    schemaVersion: await schemaVersion(context.env), contractVersion: "0.33.0",
  })));
  app.use("/api/v1/me", authenticate());
  app.use("/api/v1/me/*", authenticate());
  app.use("/api/v1/spaces", authenticate());
  app.use("/api/v1/spaces/*", authenticate());
  app.use("/api/v1/space-invites/*", authenticate());
  app.use("/api/v1/webhook-endpoints", authenticate());
  app.use("/api/v1/webhook-endpoints/*", authenticate());
  app.use("/api/v1/event-subscriptions", authenticate());
  app.use("/api/v1/event-subscriptions/*", authenticate());
  app.use("/api/v1/model-admin", authenticate());
  app.use("/api/v1/model-admin/*", authenticate());
  app.use("/api/v1/platform-admin", authenticate());
  app.use("/api/v1/platform-admin/*", authenticate());
  registerSpaceAvatarRoutes(app);
  registerGrantRoutes(app);
  registerSpaceLifecycleRoutes(app);
  registerSpaceRoutes(app);
  registerModelAdminRoutes(app);
  registerModelAdminAiRoutes(app);
  registerPlatformAdminRoutes(app);
  registerPlatformInspectorRoutes(app);
  registerRegistryCreationDraftRoutes(app);
  registerEventSubscriptionRoutes(app);
  registerAgentDelegationRoutes(app);
  registerChangeHistoryRoutes(app);
  registerRuntimeDiscoveryRoutes(app);
  registerRuntimeModelSemanticDetailRoutes(app);
  registerRelationTargetRoutes(app);
  registerGenericResourceRoutes(app);
  app.notFound((context) => context.json(failure("NOT_FOUND", "Route not found", context.get("requestId")), 404));
  app.onError((error, context) => {
    const requestId = context.get("requestId");
    if (error instanceof ApiError) return context.json(failure(error.code, error.message, requestId), error.status);
    console.error(JSON.stringify({ message: "Unhandled Core API error", requestId, error: error instanceof Error ? error.message : String(error) }));
    return context.json(failure("INTERNAL_ERROR", "Internal server error", requestId), 500);
  });
  return app;
}

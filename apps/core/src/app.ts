import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings, Variables } from "./env";
import { authenticate } from "./auth";
import { registerDelegationRoutes } from "./delegation-routes";
import { registerAuthorizationRequestRoutes } from "./authorization-request-routes";
import { registerChangeHistoryRoutes } from "./change-history";
import { registerConfigurationModelDiscoveryRoutes } from "./configuration-model-discovery";
import { registerGenericResourceRoutes } from "./generic-resource-routes";
import { registerGenericBatchRoutes } from "./generic-batch-routes";
import { registerGenericBulkRoutes } from "./generic-bulk-routes";
import { registerRuntimeDiscoveryRoutes } from "./runtime-discovery";
import { registerRuntimeModelSemanticDetailRoutes } from "./runtime-model-semantic-detail";
import { registerRelationTargetRoutes } from "./relation-targets";
import { registerSemanticRelationRoutes } from "./semantic-relation-routes";
import { registerPersonDirectoryRoutes } from "./person-directory";
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
import { logPerformanceTiming, startPerformanceTiming } from "./performance-timing";
import { CORE_KERNEL_CONTRACT_VERSION } from "./kernel-contract";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const defaultOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];
function origins(env: Bindings) { return env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean) : defaultOrigins; }
async function schemaVersion(env: Bindings) {
  const row = await env.DB.prepare("SELECT value FROM schema_metadata WHERE key='schema_version'").first<{ value: string }>();
  if (!row) throw new Error("schema version metadata is missing");
  return row.value;
}

function knownDatabaseApiError(error: unknown): ApiError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("SEMANTIC_RELATION_ENDPOINT_UNAVAILABLE")) {
    return new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
  }
  if (message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE")) {
    return new ApiError(
      "DELEGATION_INVALID",
      "A single-use Delegation was consumed, revoked or expired before commit",
      403,
    );
  }
  if (message.includes("RECURRENCE_VERSION_CONFLICT")) return new ApiError("VERSION_CONFLICT", "Recurring plan changed before commit", 409);
  if (message.includes("RECURRENCE_AUTHORITY_UNAVAILABLE")) return new ApiError("RECURRENCE_AUTHORITY_UNAVAILABLE", "Current recurring intent authority is unavailable", 403);
  if (message.includes("PERSON_VERSION_CONFLICT")) {
    return new ApiError("PERSON_VERSION_CONFLICT", "Person version conflict", 409);
  }
  if (message.includes("PERSON_LINKED_USER")) {
    return new ApiError("PERSON_LINKED_USER", "A Person linked to a current User is managed by Membership lifecycle", 409);
  }
  if (message.includes("PERSON_IN_USE")) {
    return new ApiError("PERSON_IN_USE", "Person is still referenced by active Space records", 409);
  }
  return null;
}

export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    const requestId = context.req.header("x-request-id")?.trim() || crypto.randomUUID();
    context.set("requestId", requestId);
    startPerformanceTiming(context);
    try {
      await next();
    } finally {
      context.header("x-request-id", requestId);
      logPerformanceTiming(context);
    }
  });
  app.use("*", cors({
    origin: (origin, context) => origins(context.env).includes(origin) ? origin : undefined,
    allowHeaders: ["Authorization", "Content-Type", "X-Request-ID", "X-LifeSpace-Actor-Token", "X-LifeSpace-Delegation-Id"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }));
  app.get("/health", (context) => context.json(success({ status: "ok" })));
  app.get("/api/v1/status", async (context) => context.json(success({
    status: "ok", service: "core", environment: context.env.ENVIRONMENT ?? "local", database: "available",
    schemaVersion: await schemaVersion(context.env), contractVersion: CORE_KERNEL_CONTRACT_VERSION,
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
  registerPersonDirectoryRoutes(app);
  registerModelAdminRoutes(app);
  registerModelAdminAiRoutes(app);
  registerPlatformAdminRoutes(app);
  registerPlatformInspectorRoutes(app);
  registerEventSubscriptionRoutes(app);
  registerDelegationRoutes(app);
  registerAuthorizationRequestRoutes(app);
  registerChangeHistoryRoutes(app);
  registerRuntimeDiscoveryRoutes(app);
  registerConfigurationModelDiscoveryRoutes(app);
  registerRuntimeModelSemanticDetailRoutes(app);
  registerRelationTargetRoutes(app);
  registerSemanticRelationRoutes(app);
  registerGenericBatchRoutes(app);
  registerGenericBulkRoutes(app);
  registerGenericResourceRoutes(app);
  app.notFound((context) => context.json(failure("NOT_FOUND", "Route not found", context.get("requestId")), 404));
  app.onError((error, context) => {
    const requestId = context.get("requestId");
    if (error instanceof ApiError) return context.json(failure(error.code, error.message, requestId), error.status);
    const databaseError = knownDatabaseApiError(error);
    if (databaseError) {
      return context.json(failure(databaseError.code, databaseError.message, requestId), databaseError.status);
    }
    console.error(JSON.stringify({ message: "Unhandled Core API error", requestId, error: error instanceof Error ? error.message : String(error) }));
    return context.json(failure("INTERNAL_ERROR", "Internal server error", requestId), 500);
  });
  return app;
}


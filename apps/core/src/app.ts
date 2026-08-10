import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Bindings, Variables } from "./env";
import { authenticate } from "./auth";
import { ApiError, failure, success } from "./http";
import { registerSpaceRoutes } from "./spaces";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const defaultOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"];

function origins(env: Bindings) {
  return env.CORS_ORIGINS ? env.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean) : defaultOrigins;
}

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
    allowHeaders: ["Authorization", "Content-Type", "X-Request-ID"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }));
  app.get("/health", (context) => context.json(success({ status: "ok" })));
  app.get("/api/v1/status", async (context) => context.json(success({
    status: "ok",
    service: "core",
    environment: context.env.ENVIRONMENT ?? "local",
    database: "available",
    schemaVersion: await schemaVersion(context.env),
    contractVersion: "0.2.0",
  })));
  app.use("/api/v1/me", authenticate());
  app.use("/api/v1/me/*", authenticate());
  app.use("/api/v1/spaces", authenticate());
  app.use("/api/v1/spaces/*", authenticate());
  app.use("/api/v1/space-invites/*", authenticate());
  registerSpaceRoutes(app);
  app.notFound((context) => context.json(failure("NOT_FOUND", "Route not found", context.get("requestId")), 404));
  app.onError((error, context) => {
    const requestId = context.get("requestId");
    if (error instanceof ApiError) return context.json(failure(error.code, error.message, requestId), error.status);
    console.error(JSON.stringify({ message: "Unhandled Core API error", requestId, error: error instanceof Error ? error.message : String(error) }));
    return context.json(failure("INTERNAL_ERROR", "Internal server error", requestId), 500);
  });
  return app;
}

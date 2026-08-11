import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import {
  createGenericResource,
  deleteGenericResource,
  getGenericResource,
  type GenericResource,
  updateGenericResource,
} from "./generic-resource";
import { queryGenericResources } from "./generic-query";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getPublishedModelByRoute, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { executeWorkflowAction, workflowActionAccess } from "./workflow";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  return value as Body;
}

function positiveVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new ApiError("INVALID_REQUEST", "version must be a positive integer", 400);
  return Number(value);
}

async function model(context: Context<AppEnv>): Promise<PublishedModel> {
  const route = context.req.param("modelRoute");
  if (!route) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  const model = await getPublishedModelByRoute(context.env, route);
  if (!model) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  return model;
}

async function requireActiveSpace(env: Bindings, spaceId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL").bind(spaceId).first<{ id: string }>();
  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
}

function dto(resource: GenericResource) {
  return {
    id: resource.id,
    spaceId: resource.spaceId,
    modelKey: resource.modelKey,
    modelVersion: resource.modelVersion,
    ...resource.data,
    version: resource.version,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

export function registerGenericResourceRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/:modelRoute", async (context) => {
    const spaceId = context.req.param("spaceId");
    await requireActiveSpace(context.env, spaceId);
    const resolved = await model(context);
    const principal = context.get("principal");
    await requireModelAccess(context.env, principal, spaceId, resolved, "read");
    await requireModelPolicy(context.env, principal, spaceId, resolved, "read");
    const result = await queryGenericResources(context.env, spaceId, resolved, new URL(context.req.url).searchParams);
    return context.json(success({ items: result.items.map(dto), nextCursor: result.nextCursor }));
  });

  app.post("/api/v1/spaces/:spaceId/:modelRoute", async (context) => {
    const spaceId = context.req.param("spaceId");
    await requireActiveSpace(context.env, spaceId);
    const resolved = await model(context);
    const principal = context.get("principal");
    await requireModelAccess(context.env, principal, spaceId, resolved, "write");
    const input = await body(context);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "create", undefined, input);
    const created = await createGenericResource(context.env, principal, spaceId, resolved, input);
    return context.json(success(dto(created)), 201);
  });

  app.get("/api/v1/spaces/:spaceId/:modelRoute/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    await requireActiveSpace(context.env, spaceId);
    const resolved = await model(context);
    const principal = context.get("principal");
    await requireModelAccess(context.env, principal, spaceId, resolved, "read");
    const resource = await getGenericResource(context.env, spaceId, resolved.key, context.req.param("recordId"));
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "read", resource);
    return context.json(success(dto(resource)));
  });

  app.patch("/api/v1/spaces/:spaceId/:modelRoute/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    await requireActiveSpace(context.env, spaceId);
    const resolved = await model(context);
    const principal = context.get("principal");
    await requireModelAccess(context.env, principal, spaceId, resolved, "write");
    const input = await body(context);
    const expected = positiveVersion(input.version);
    const changes = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "version"));
    if (!Object.keys(changes).length) throw new ApiError("INVALID_REQUEST", "At least one resource field change is required", 400);
    const resource = await getGenericResource(context.env, spaceId, resolved.key, context.req.param("recordId"));
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "update", resource, changes);
    const updated = await updateGenericResource(context.env, principal, spaceId, resolved, resource.id, expected, changes);
    return context.json(success(dto(updated)));
  });

  app.delete("/api/v1/spaces/:spaceId/:modelRoute/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    await requireActiveSpace(context.env, spaceId);
    const resolved = await model(context);
    const principal = context.get("principal");
    await requireModelAccess(context.env, principal, spaceId, resolved, "write");
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "version")) throw new ApiError("INVALID_REQUEST", "Delete accepts only version", 400);
    const resource = await getGenericResource(context.env, spaceId, resolved.key, context.req.param("recordId"));
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "delete", resource);
    await deleteGenericResource(context.env, principal, spaceId, resolved, resource.id, positiveVersion(input.version));
    return context.body(null, 204);
  });

  app.post("/api/v1/spaces/:spaceId/:modelRoute/:recordId/actions/:actionKey", async (context) => {
    const spaceId = context.req.param("spaceId");
    await requireActiveSpace(context.env, spaceId);
    const resolved = await model(context);
    const actionKey = context.req.param("actionKey");
    if (!actionKey) throw new ApiError("ACTION_NOT_FOUND", "Action not found", 404);
    const requiredAccess = workflowActionAccess(resolved, actionKey);
    await requireModelAccess(context.env, context.get("principal"), spaceId, resolved, requiredAccess);
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "version")) throw new ApiError("INVALID_REQUEST", "Action accepts only version in Model Definition v1", 400);
    const updated = await executeWorkflowAction(
      context.env,
      context.get("principal"),
      spaceId,
      resolved,
      context.req.param("recordId"),
      actionKey,
      positiveVersion(input.version),
    );
    return context.json(success(dto(updated)));
  });
}

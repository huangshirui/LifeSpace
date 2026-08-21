import type { Context, Hono } from "hono";
import { isCalendarSpecialQuery, queryCalendarResources } from "./calendar-query";
import {
  capabilityActionAccess,
  createCapabilityAwareResource,
  decorateCapabilityResponse,
  decorateCapabilityResponses,
  executeCapabilityAction,
  listCapabilityOccurrences,
  prepareCapabilityCreateInput,
  prepareCapabilityUpdatePolicyInput,
  updateCapabilityAwareResource,
  type CapabilityResponseDecoration,
} from "./capability-runtime";
import type { Bindings, Variables } from "./env";
import { deleteGenericResource, getGenericResource, type GenericResource } from "./generic-resource";
import { queryGenericResources } from "./generic-query";
import { isTemporalSpecialQuery, queryTemporalResources } from "./temporal-query";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModelByRoute, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { loadResourceAudits, requireResourceAudit, type ResourceAudit } from "./resource-audit";
import { executeWorkflowAction, workflowActionAccess } from "./workflow";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  return value as Body;
}
function positiveVersion(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 1) throw new ApiError("INVALID_REQUEST", "version must be a positive integer", 400);
  return Number(value);
}
async function model(context: Context<AppEnv>): Promise<PublishedModel> {
  const route = context.req.param("modelRoute");
  const resolved = route ? await getRuntimeModelByRoute(context.env, route) : null;
  if (!resolved) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
  return resolved;
}
async function dto(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  resource: GenericResource,
  decoration?: CapabilityResponseDecoration,
  audit?: ResourceAudit,
) {
  const resolvedAudit = audit ?? requireResourceAudit(
    await loadResourceAudits(env, spaceId, [resource.id]),
    resource.id,
  );
  return {
    id: resource.id,
    spaceId: resource.spaceId,
    modelKey: resource.modelKey,
    modelVersion: resource.modelVersion,
    ...resource.data,
    ...(decoration ?? await decorateCapabilityResponse(env, spaceId, model, resource)),
    createdBy: resolvedAudit.createdBy,
    updatedBy: resolvedAudit.updatedBy,
    version: resource.version,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  };
}

export function registerGenericResourceRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/:modelRoute", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "read");
    await requireModelPolicy(context.env, principal, spaceId, resolved, "read", undefined, undefined, { personId: access.actorPersonId });
    const params = new URL(context.req.url).searchParams;
    const result = isTemporalSpecialQuery(resolved, params)
      ? await queryTemporalResources(context.env, principal, spaceId, resolved, params)
      : isCalendarSpecialQuery(resolved, params)
        ? await queryCalendarResources(context.env, principal, spaceId, resolved, params)
        : await queryGenericResources(context.env, spaceId, resolved, params);
    const [decorations, audits] = await Promise.all([
      decorateCapabilityResponses(context.env, spaceId, resolved, result.items),
      loadResourceAudits(context.env, spaceId, result.items.map((resource) => resource.id)),
    ]);
    const items = await Promise.all(result.items.map((resource, index) => dto(
      context.env,
      spaceId,
      resolved,
      resource,
      decorations[index],
      requireResourceAudit(audits, resource.id),
    )));
    return context.json(success({ items, nextCursor: result.nextCursor }));
  });

  app.post("/api/v1/spaces/:spaceId/:modelRoute", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "write");
    const input = await body(context);
    const prepared = prepareCapabilityCreateInput(resolved, input);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "create", undefined, prepared, { personId: access.actorPersonId });
    const created = await createCapabilityAwareResource(context.env, principal, spaceId, resolved, prepared);
    return context.json(success(await dto(context.env, spaceId, resolved, created)), 201);
  });

  app.get("/api/v1/spaces/:spaceId/:modelRoute/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "read");
    const resource = await getGenericResource(context.env, spaceId, resolved, context.req.param("recordId"));
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "read", resource, undefined, { personId: access.actorPersonId });
    return context.json(success(await dto(context.env, spaceId, resolved, resource)));
  });

  app.patch("/api/v1/spaces/:spaceId/:modelRoute/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "write");
    const input = await body(context);
    const expected = positiveVersion(input.version);
    const changes = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "version"));
    if (!Object.keys(changes).length) throw new ApiError("INVALID_REQUEST", "At least one resource field change is required", 400);
    const prepared = await prepareCapabilityUpdatePolicyInput(context.env, spaceId, resolved, context.req.param("recordId"), changes);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "update", prepared.resource, prepared.prepared, { personId: access.actorPersonId });
    const updated = await updateCapabilityAwareResource(context.env, principal, spaceId, resolved, prepared.resource.id, expected, changes, prepared.resource);
    return context.json(success(await dto(context.env, spaceId, resolved, updated)));
  });

  app.delete("/api/v1/spaces/:spaceId/:modelRoute/:recordId", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "write");
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "version")) throw new ApiError("INVALID_REQUEST", "Delete accepts only version", 400);
    const resource = await getGenericResource(context.env, spaceId, resolved, context.req.param("recordId"));
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "delete", resource, undefined, { personId: access.actorPersonId });
    await deleteGenericResource(context.env, principal, spaceId, resolved, resource.id, positiveVersion(input.version));
    return context.body(null, 204);
  });

  app.get("/api/v1/spaces/:spaceId/:modelRoute/:recordId/occurrences", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "read");
    const resource = await getGenericResource(context.env, spaceId, resolved, context.req.param("recordId"));
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "read", resource, undefined, { personId: access.actorPersonId });
    const rawLimit = new URL(context.req.url).searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("INVALID_QUERY", "limit must be between 1 and 200", 400);
    const result = await listCapabilityOccurrences(context.env, spaceId, resolved, resource.id, limit, new URL(context.req.url).searchParams.get("cursor") ?? undefined);
    return context.json(success(result));
  });

  app.post("/api/v1/spaces/:spaceId/:modelRoute/:recordId/actions/:actionKey", async (context) => {
    const spaceId = context.req.param("spaceId");
    const resolved = await model(context);
    const actionKey = context.req.param("actionKey");
    if (!actionKey) throw new ApiError("ACTION_NOT_FOUND", "Action not found", 404);
    const capabilityAccess = capabilityActionAccess(resolved, actionKey);
    const requiredAccess = capabilityAccess ?? workflowActionAccess(resolved, actionKey);
    const access = await requireModelAccess(context.env, context.get("principal"), spaceId, resolved, requiredAccess);
    const input = await body(context);
    if (capabilityAccess) {
      const updated = await executeCapabilityAction(context.env, context.get("principal"), spaceId, resolved, context.req.param("recordId"), actionKey, input);
      return context.json(success(await dto(context.env, spaceId, resolved, updated)));
    }
    if (Object.keys(input).some((key) => key !== "version")) throw new ApiError("INVALID_REQUEST", "Action accepts only version in Model Definition v1", 400);
    const updated = await executeWorkflowAction(
      context.env,
      context.get("principal"),
      spaceId,
      resolved,
      context.req.param("recordId"),
      actionKey,
      positiveVersion(input.version),
      { personId: access.actorPersonId },
    );
    return context.json(success(await dto(context.env, spaceId, resolved, updated)));
  });
}

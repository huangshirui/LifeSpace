import type { Context, Hono } from "hono";
import { isCalendarSpecialQuery, queryCalendarResources } from "./calendar-query";
import { queryCanonicalResources } from "./canonical-query";
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
import { hasLegacyGenericCursor, queryGenericResources, translateGenericGetQuery } from "./generic-query";
import { isTemporalSpecialQuery, queryTemporalResources } from "./temporal-query";
import { ApiError, success } from "./http";
import { consumeSingleUseRead, requireModelAccess } from "./model-authorization";
import { measurePerformancePhase } from "./performance-timing";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
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
function pathParam(context: Context<AppEnv>, name: string): string {
  const value = context.req.param(name);
  if (!value) throw new ApiError("NOT_FOUND", "Runtime path parameter is missing", 404);
  return value;
}
function requestModelKey(context: Context<AppEnv>): string {
  return context.req.param("modelKey") ?? "";
}

function delegationId(context: Context<AppEnv>): string | null {
  const value = context.req.header("x-lifespace-delegation-id")?.trim();
  return value || null;
}

function accessSelector(context: Context<AppEnv>, recordId?: string) {
  return {
    delegationId: delegationId(context),
    ...(recordId ? { recordId } : {}),
  };
}
async function model(context: Context<AppEnv>): Promise<PublishedModel> {
  return measurePerformancePhase(context, "runtime.model_resolution", async () => {
    const resolved = await getRuntimeModel(context.env, requestModelKey(context));
    if (!resolved) throw new ApiError("MODEL_NOT_FOUND", "Published model not found", 404);
    return resolved;
  });
}

const canonical = {
  collection: "/api/v1/spaces/:spaceId/models/:modelKey/records",
  query: "/api/v1/spaces/:spaceId/models/:modelKey/records/query",
  record: "/api/v1/spaces/:spaceId/models/:modelKey/records/:recordId",
  occurrences: "/api/v1/spaces/:spaceId/models/:modelKey/records/:recordId/occurrences",
  action: "/api/v1/spaces/:spaceId/models/:modelKey/records/:recordId/actions/:actionKey",
} as const;
async function dto(
  env: Bindings,
  spaceId: string,
  model: PublishedModel,
  resource: GenericResource,
  decoration?: CapabilityResponseDecoration,
  audit?: ResourceAudit,
) {
  const resolvedAudit = audit ?? resource.audit ?? requireResourceAudit(
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

async function listResponse(
  context: Context<AppEnv>,
  spaceId: string,
  resolved: PublishedModel,
  result: { items: GenericResource[]; nextCursor: string | null },
) {
  const missingAuditIds = result.items
    .filter((resource) => !resource.audit)
    .map((resource) => resource.id);
  const [decorations, fallbackAudits] = await Promise.all([
    decorateCapabilityResponses(context.env, spaceId, resolved, result.items),
    missingAuditIds.length
      ? loadResourceAudits(context.env, spaceId, missingAuditIds)
      : Promise.resolve(new Map<string, ResourceAudit>()),
  ]);
  const items = await Promise.all(result.items.map((resource, index) => dto(
    context.env,
    spaceId,
    resolved,
    resource,
    decorations[index],
    resource.audit ?? requireResourceAudit(fallbackAudits, resource.id),
  )));
  return context.json(success({ items, nextCursor: result.nextCursor }));
}

export function registerGenericResourceRoutes(app: App): void {
  const list = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await measurePerformancePhase(
      context,
      "runtime.access_check",
      () => requireModelAccess(context.env, principal, spaceId, resolved, "read", accessSelector(context)),
    );
    await measurePerformancePhase(
      context,
      "runtime.policy",
      () => requireModelPolicy(context.env, principal, spaceId, resolved, "read", undefined, undefined, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId }),
    );
    const params = new URL(context.req.url).searchParams;
    const result = await measurePerformancePhase(context, "runtime.query", async () =>
      isTemporalSpecialQuery(resolved, params)
        ? queryTemporalResources(context.env, principal, spaceId, resolved, params)
        : isCalendarSpecialQuery(resolved, params)
          ? queryCalendarResources(context.env, principal, spaceId, resolved, params)
          : hasLegacyGenericCursor(params)
            ? queryGenericResources(context.env, spaceId, resolved, params)
            : queryCanonicalResources(
                context.env,
                principal,
                spaceId,
                resolved,
                translateGenericGetQuery(resolved, params),
                access.policyIdentity.principalPersonId,
              ),
    );
    const response = await measurePerformancePhase(
      context,
      "runtime.response_projection",
      () => listResponse(context, spaceId, resolved, result),
    );
    await consumeSingleUseRead(context.env, access);
    return response;
  };
  app.get(canonical.collection, list);

  const query = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await measurePerformancePhase(
      context,
      "runtime.access_check",
      () => requireModelAccess(context.env, principal, spaceId, resolved, "read", accessSelector(context)),
    );
    await measurePerformancePhase(
      context,
      "runtime.policy",
      () => requireModelPolicy(context.env, principal, spaceId, resolved, "read", undefined, undefined, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId }),
    );
    const input = await body(context);
    const result = await measurePerformancePhase(
      context,
      "runtime.query",
      () => queryCanonicalResources(
        context.env,
        principal,
        spaceId,
        resolved,
        input,
        access.policyIdentity.principalPersonId,
      ),
    );
    const response = await measurePerformancePhase(
      context,
      "runtime.response_projection",
      () => listResponse(context, spaceId, resolved, result),
    );
    await consumeSingleUseRead(context.env, access);
    return response;
  };
  app.post(canonical.query, query);

  const create = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const access = await measurePerformancePhase(
      context,
      "runtime.access_check",
      () => requireModelAccess(context.env, principal, spaceId, resolved, "write", accessSelector(context)),
    );
    const input = await body(context);
    const prepared = prepareCapabilityCreateInput(resolved, input);
    await measurePerformancePhase(
      context,
      "runtime.policy",
      () => requireModelPolicy(context.env, principal, spaceId, resolved, "create", undefined, prepared, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId }),
    );
    const created = await measurePerformancePhase(
      context,
      "runtime.create_write",
      () => createCapabilityAwareResource(
        context.env,
        principal,
        spaceId,
        resolved,
        input,
        undefined,
        { delegationId: access.authority.delegationId, delegationChain: access.authority.delegationChain },
      ),
    );
    const response = await measurePerformancePhase(
      context,
      "runtime.response_projection",
      () => dto(context.env, spaceId, resolved, created),
    );
    return context.json(success(response), 201);
  };
  app.post(canonical.collection, create);

  const get = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const recordId = pathParam(context, "recordId");
    const access = await measurePerformancePhase(
      context,
      "runtime.access_check",
      () => requireModelAccess(context.env, principal, spaceId, resolved, "read", accessSelector(context, recordId)),
    );
    const resource = await measurePerformancePhase(
      context,
      "runtime.record_read",
      () => getGenericResource(context.env, spaceId, resolved, recordId),
    );
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await measurePerformancePhase(
      context,
      "runtime.policy",
      () => requireModelPolicy(context.env, principal, spaceId, resolved, "read", resource, undefined, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId }),
    );
    const response = await measurePerformancePhase(
      context,
      "runtime.response_projection",
      () => dto(context.env, spaceId, resolved, resource),
    );
    await consumeSingleUseRead(context.env, access);
    return context.json(success(response));
  };
  app.get(canonical.record, get);

  const update = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const recordId = pathParam(context, "recordId");
    const access = await measurePerformancePhase(
      context,
      "runtime.access_check",
      () => requireModelAccess(context.env, principal, spaceId, resolved, "write", accessSelector(context, recordId)),
    );
    const request = await body(context);
    const expected = positiveVersion(request.version);
    const changes = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "version"));
    if (!Object.keys(changes).length) throw new ApiError("INVALID_REQUEST", "At least one resource field change is required", 400);
    const prepared = await measurePerformancePhase(
      context,
      "runtime.update_prepare",
      () => prepareCapabilityUpdatePolicyInput(context.env, spaceId, resolved, recordId, changes),
    );
    await measurePerformancePhase(
      context,
      "runtime.policy",
      () => requireModelPolicy(context.env, principal, spaceId, resolved, "update", prepared.resource, prepared.prepared, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId }),
    );
    const updated = await measurePerformancePhase(
      context,
      "runtime.update_write",
      () => updateCapabilityAwareResource(
        context.env,
        principal,
        spaceId,
        resolved,
        prepared.resource.id,
        expected,
        changes,
        prepared.resource,
        undefined,
        { delegationId: access.authority.delegationId, delegationChain: access.authority.delegationChain },
      ),
    );
    const response = await measurePerformancePhase(
      context,
      "runtime.response_projection",
      () => dto(context.env, spaceId, resolved, updated),
    );
    return context.json(success(response));
  };
  app.patch(canonical.record, update);

  const remove = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const recordId = pathParam(context, "recordId");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "write", accessSelector(context, recordId));
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "version")) throw new ApiError("INVALID_REQUEST", "Delete accepts only version", 400);
    const resource = await getGenericResource(context.env, spaceId, resolved, recordId);
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "delete", resource, undefined, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId });
    await deleteGenericResource(
      context.env,
      principal,
      spaceId,
      resolved,
      resource.id,
      positiveVersion(input.version),
      { delegationId: access.authority.delegationId, delegationChain: access.authority.delegationChain },
    );
    return context.body(null, 204);
  };
  app.delete(canonical.record, remove);

  const occurrences = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const principal = context.get("principal");
    const recordId = pathParam(context, "recordId");
    const access = await requireModelAccess(context.env, principal, spaceId, resolved, "read", accessSelector(context, recordId));
    const resource = await getGenericResource(context.env, spaceId, resolved, recordId);
    if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    await requireModelPolicy(context.env, principal, spaceId, resolved, "read", resource, undefined, { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId });
    const rawLimit = new URL(context.req.url).searchParams.get("limit");
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiError("INVALID_QUERY", "limit must be between 1 and 200", 400);
    const result = await listCapabilityOccurrences(context.env, spaceId, resolved, resource.id, limit, new URL(context.req.url).searchParams.get("cursor") ?? undefined);
    await consumeSingleUseRead(context.env, access);
    return context.json(success(result));
  };
  app.get(canonical.occurrences, occurrences);

  const action = async (context: Context<AppEnv>) => {
    const spaceId = pathParam(context, "spaceId");
    const resolved = await model(context);
    const actionKey = pathParam(context, "actionKey");
    const capabilityAccess = capabilityActionAccess(resolved, actionKey);
    const requiredAccess = capabilityAccess ?? workflowActionAccess(resolved, actionKey);
    const recordId = pathParam(context, "recordId");
    const access = await requireModelAccess(
      context.env,
      context.get("principal"),
      spaceId,
      resolved,
      requiredAccess,
      accessSelector(context, recordId),
    );
    const input = await body(context);
    if (capabilityAccess) {
      const updated = await executeCapabilityAction(
        context.env,
        context.get("principal"),
        spaceId,
        resolved,
        recordId,
        actionKey,
        input,
        { delegationId: access.authority.delegationId, delegationChain: access.authority.delegationChain },
      );
      return context.json(success(await dto(context.env, spaceId, resolved, updated)));
    }
    if (Object.keys(input).some((key) => key !== "version")) throw new ApiError("INVALID_REQUEST", "Action accepts only version in Model Definition v1", 400);
    const updated = await executeWorkflowAction(
      context.env,
      context.get("principal"),
      spaceId,
      resolved,
      recordId,
      actionKey,
      positiveVersion(input.version),
      { principalPersonId: access.policyIdentity.principalPersonId, actorPersonId: access.policyIdentity.actorPersonId },
      { delegationId: access.authority.delegationId, delegationChain: access.authority.delegationChain },
    );
    return context.json(success(await dto(context.env, spaceId, resolved, updated)));
  };
  app.post(canonical.action, action);
}

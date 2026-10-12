import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { measurePerformancePhase } from "./performance-timing";
import {
  createSemanticRelation,
  deleteSemanticRelation,
  getSemanticRelation,
  querySemanticRelations,
  type SemanticEntityRef,
  type SemanticRelationCreateInput,
  type SemanticRelationQuery,
} from "./semantic-relation";
import { isSemanticRelationPredicate } from "./semantic-relation-definition";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", message, 400);
  }
  return value as Record<string, unknown>;
}

function delegationId(context: Context<AppEnv>): string | null {
  return context.req.header("x-lifespace-delegation-id")?.trim() || null;
}

function parseRef(value: unknown, name: "source" | "target"): SemanticEntityRef {
  const input = object(value, `${name} must be a record entity_ref`);
  if (Object.keys(input).some((key) => !["kind", "modelKey", "recordId"].includes(key))
      || input.kind !== "record"
      || typeof input.modelKey !== "string"
      || typeof input.recordId !== "string") {
    throw new ApiError("INVALID_REQUEST", `${name} must contain kind=record, modelKey and recordId`, 400);
  }
  return { kind: "record", modelKey: input.modelKey, recordId: input.recordId };
}

async function createInput(context: Context<AppEnv>): Promise<SemanticRelationCreateInput> {
  const input = object(
    await context.req.json<unknown>().catch(() => null),
    "Semantic Relation body must be an object",
  );
  if (Object.keys(input).some((key) => !["source", "predicate", "target"].includes(key))) {
    throw new ApiError("INVALID_REQUEST", "Semantic Relation create accepts only source, predicate and target", 400);
  }
  if (typeof input.predicate !== "string" || !isSemanticRelationPredicate(input.predicate)) {
    throw new ApiError("INVALID_REQUEST", "predicate is not registered by LifeSpace", 400);
  }
  return {
    source: parseRef(input.source, "source"),
    predicate: input.predicate,
    target: parseRef(input.target, "target"),
  };
}

function pair(params: URLSearchParams, prefix: "source" | "target"): SemanticEntityRef | undefined {
  const modelKey = params.get(`${prefix}ModelKey`);
  const recordId = params.get(`${prefix}RecordId`);
  if (!modelKey && !recordId) return undefined;
  if (!modelKey || !recordId) {
    throw new ApiError(
      "INVALID_QUERY",
      `${prefix}ModelKey and ${prefix}RecordId must be supplied together`,
      400,
    );
  }
  return { kind: "record", modelKey, recordId };
}

function hydrate(params: URLSearchParams): SemanticRelationQuery["hydrate"] {
  const value = params.get("hydrate");
  if (value === null) return undefined;
  if (value === "source" || value === "target" || value === "both") return value;
  throw new ApiError("INVALID_QUERY", "hydrate must be source, target, or both", 400);
}

function queryInput(context: Context<AppEnv>): SemanticRelationQuery {
  const params = new URL(context.req.url).searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  const rawPredicate = params.get("predicate");
  if (rawPredicate !== null && !isSemanticRelationPredicate(rawPredicate)) {
    throw new ApiError("INVALID_QUERY", "predicate is not registered by LifeSpace", 400);
  }
  return {
    source: pair(params, "source"),
    target: pair(params, "target"),
    ...(rawPredicate ? { predicate: rawPredicate } : {}),
    limit,
    ...(params.get("cursor") ? { cursor: params.get("cursor")! } : {}),
    delegationId: delegationId(context),
    hydrate: hydrate(params),
  };
}

export function registerSemanticRelationRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/semantic-relations", async (context) => {
    const spaceId = context.req.param("spaceId");
    const input = await createInput(context);
    const relation = await measurePerformancePhase(
      context,
      "semantic_relation.create",
      () => createSemanticRelation(
        context.env,
        context.get("principal"),
        spaceId,
        input,
        delegationId(context),
      ),
    );
    return context.json(success(relation), 200);
  });

  app.get("/api/v1/spaces/:spaceId/semantic-relations", async (context) => {
    const result = await measurePerformancePhase(
      context,
      "semantic_relation.query",
      () => querySemanticRelations(
        context.env,
        context.get("principal"),
        context.req.param("spaceId"),
        queryInput(context),
      ),
    );
    return context.json(success(result));
  });

  app.get("/api/v1/spaces/:spaceId/semantic-relations/:relationId", async (context) => {
    const params = new URL(context.req.url).searchParams;
    const relation = await measurePerformancePhase(
      context,
      "semantic_relation.get",
      () => getSemanticRelation(
        context.env,
        context.get("principal"),
        context.req.param("spaceId"),
        context.req.param("relationId"),
        delegationId(context),
        hydrate(params),
      ),
    );
    if (!relation) throw new ApiError("RESOURCE_NOT_FOUND", "Resource not found", 404);
    return context.json(success(relation));
  });

  app.delete("/api/v1/spaces/:spaceId/semantic-relations/:relationId", async (context) => {
    await measurePerformancePhase(
      context,
      "semantic_relation.delete",
      () => deleteSemanticRelation(
        context.env,
        context.get("principal"),
        context.req.param("spaceId"),
        context.req.param("relationId"),
        delegationId(context),
      ),
    );
    return context.body(null, 204);
  });
}

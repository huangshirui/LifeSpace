import type { Context, Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { normalizeCanonicalQueryOperand } from "./canonical-query";
import { normalizeCanonicalFieldValue } from "./generic-resource";
import { recurrenceRuleSchema } from "./recurrence-rule";
import { entityRefSchema } from "./entity-ref";
import {
  consumeSingleUseRead,
  evaluateModelAccessMany,
  requireModelAccess,
  type ModelAccessDecision,
} from "./model-authorization";
import {
  boundedString,
  callExternalAdapter,
  canonicalExternalJson,
  externalAuthorityModel,
  externalHash,
  ExternalError,
  getExternalModel,
  isExternalModelKey,
  isExternalModelAddress,
  externalBusinessKey,
  listExternalModels,
  objectInput,
  onlyKeys,
  refreshExternalModel,
  nextExternalRefresh,
  type ExternalField,
  type ExternalModel,
  type ExternalOperation,
} from "./external-model";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
function capabilities(m: ExternalModel, allowed: string[]) {
  const read = allowed.includes("read"),
    write = allowed.includes("write") && m.declared_access === "write";
  return {
    ...m.snapshot.capabilities,
    get: read && m.snapshot.capabilities.get,
    query: read && m.snapshot.capabilities.query,
    create: write && m.snapshot.capabilities.create,
    update: write && m.snapshot.capabilities.update,
    delete: write && m.snapshot.capabilities.delete,
    batchWrite: write && m.snapshot.capabilities.batchWrite,
    relationTargetResolution:
      read &&
      Boolean(m.businessDefinition) &&
      m.snapshot.capabilities.get &&
      m.snapshot.capabilities.relationTargetResolution,
  };
}
export function externalSemanticDetail(
  m: ExternalModel,
  allowed: string[] = externalAuthorityModel(m).definition.access,
) {
  const readable = m.snapshot.fields.map(({ sourceFieldId: _id, ...f }) => ({
    ...f,
    ...(f.type === "recurrence_rule"
      ? { valueSchema: recurrenceRuleSchema() }
      : f.type === "entity_ref"
        ? { valueSchema: entityRefSchema() }
        : {}),
    writable:
      f.writable && allowed.includes("write") && m.declared_access === "write",
  }));
  return {
    key: externalBusinessKey(m),
    modelKey: externalBusinessKey(m),
    registrationId: m.model_key,
    ...(m.businessDefinition ? { definition: { key: m.businessDefinition.key, version: m.businessDefinition.version, schemaHash: m.businessDefinition.schemaHash }, description: m.businessDefinition.definition.description ?? null, semanticRelations: m.businessDefinition.definition.semanticRelations ?? {} } : {}),
    origin: "external",
    spaceId: m.space_id,
    schemaHash: m.schema_hash,
    schemaObservedAt: m.schema_observed_at,
    display: m.businessDefinition?.definition.display ?? { singular: m.display_name, plural: m.display_name },
    access: allowed,
    status: m.status,
    fields: readable,
    actions: [],
    capabilities: [],
    capabilityBindings: {},
    runtimeCapabilities: capabilities(m, allowed),
    contract: { kind: "dynamic", revision: null },
    query: {
      canonical: {
        invocation: {
          method: "POST",
          pathTemplate:
            "/api/v1/spaces/{spaceId}/models/{modelKey}/records/query",
        },
        composition: {
          selectionFacets: ["search", "filter"],
          selectionCombine: "intersection",
          ordering: "sort",
          pagination: "cursor-pagination",
        },
        search: null,
        filter: {
          maxDepth: m.snapshot.queryLimits.maxDepth,
          maxNodes: m.snapshot.queryLimits.maxNodes,
          targets: readable
            .filter((f) => f.operators.length)
            .map((f) => ({
              field: f.key,
              kind: "field",
              valueType: f.type,
              operators: f.operators,
              nullable: f.nullable,
            })),
        },
        sort: {
          fields: readable.filter((f) => f.sortable).map((f) => f.key),
          directions: ["asc", "desc"],
          maxCriteria: m.snapshot.queryLimits.maxSort,
          default: [],
          nullPlacement: "provider-defined",
          stableTieBreaker: "provider-defined",
          temporalRange: null,
        },
        pagination: {
          limit: {
            minimum: 1,
            maximum: m.snapshot.queryLimits.maxPageSize,
            default: m.snapshot.queryLimits.maxPageSize,
          },
          cursor: {
            opaque: true,
            binds: [
              "space",
              "model",
              "schema",
              "normalized-query",
              "provider-cursor",
            ],
            snapshotConsistency: false,
          },
        },
      },
    },
  };
}
export async function visibleExternalModels(
  env: Bindings,
  p: Principal,
  spaceIds: readonly string[],
  delegationId?: string | null,
): Promise<Map<string, ReturnType<typeof externalSemanticDetail>[]>> {
  const models = await listExternalModels(env, spaceIds);
  const groups = new Map<string, ReturnType<typeof externalSemanticDetail>[]>();
  // Current Authority functions, never independently reconstruct an External ACL.
  for (const space of [...new Set(models.map((m) => m.space_id))]) {
    const local = models.filter((m) => m.space_id === space);
    const requests = local.flatMap((m) =>
      externalAuthorityModel(m).definition.access.map((required) => ({
        model: externalAuthorityModel(m),
        required,
        selector: { delegationId },
      })),
    );
    const checks = await evaluateModelAccessMany(env, p, space, requests);
    let offset = 0;
    for (const m of local) {
      const declared = externalAuthorityModel(m).definition.access;
      const allowed = declared.filter((_a, i) => checks[offset + i]?.ok);
      offset += declared.length;
      if (allowed.length) {
        const list = groups.get(space) ?? [];
        list.push(externalSemanticDetail(m, allowed));
        groups.set(space, list);
      }
    }
  }
  return groups;
}
function canonicalExternalValue(field: ExternalField, value: unknown): unknown {
  try {
    return normalizeCanonicalFieldValue(field.key, field, value);
  } catch {
    throw new ApiError(
      "VALIDATION_ERROR",
      "Value does not match current canonical External schema",
      422,
    );
  }
}
function validateData(
  m: ExternalModel,
  input: Record<string, unknown>,
  operation: "create" | "update",
): Record<string, unknown> {
  if (canonicalExternalJson(input).length > 128000)
    throw new ApiError("INVALID_REQUEST", "External input is too large", 400);
  if (operation === "create") {
    const missing = m.snapshot.fields.find(
      (field) =>
        field.required === true &&
        field.readOnly !== true &&
        !Object.prototype.hasOwnProperty.call(input, field.key),
    );
    if (missing)
      throw new ApiError(
        "VALIDATION_ERROR",
        `Required field ${missing.key} is missing`,
        422,
      );
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const field = m.snapshot.fields.find((candidate) => candidate.key === key);
    if (!field?.writable || field.readOnly === true)
      throw new ApiError(
        "VALIDATION_ERROR",
        "Field is unavailable or read-only",
        422,
      );
    if (operation === "update" && field.immutable === true)
      throw new ApiError(
        "VALIDATION_ERROR",
        `Field ${field.key} is immutable`,
        422,
      );
    normalized[key] = canonicalExternalValue(field, value);
  }
  return normalized;
}
function validateQuery(m: ExternalModel, input: Record<string, unknown>) {
  onlyKeys(input, ["filter", "sort", "page"]);
  let nodes = 0;
  function filter(v: unknown, depth = 0): void {
    if (
      ++nodes > m.snapshot.queryLimits.maxNodes ||
      depth > m.snapshot.queryLimits.maxDepth
    )
      throw new ApiError("INVALID_QUERY", "Filter budget exceeded", 422);
    const f = objectInput(v);
    if ("and" in f || "or" in f) {
      if (depth >= m.snapshot.queryLimits.maxDepth)
        throw new ApiError(
          "EXTERNAL_QUERY_UNSUPPORTED",
          "Filter nesting is unavailable",
          422,
        );
      const k = "and" in f ? "and" : "or";
      onlyKeys(f, [k]);
      if (!Array.isArray(f[k]) || !f[k].length)
        throw new ApiError("INVALID_QUERY", "Boolean group is empty", 422);
      for (const c of f[k]) filter(c, depth + 1);
      return;
    }
    onlyKeys(f, ["field", "op", "value"]);
    const field = m.snapshot.fields.find((x) => x.key === f.field);
    if (!field || !field.operators.includes(String(f.op)))
      throw new ApiError(
        "EXTERNAL_QUERY_UNSUPPORTED",
        "Operator is unavailable in current schema",
        422,
      );
    if (f.op === "isNull" || f.op === "isNotNull") {
      if ("value" in f)
        throw new ApiError(
          "INVALID_QUERY",
          "Null predicate accepts no value",
          422,
        );
    } else {
      if (f.value === null)
        throw new ApiError(
          "INVALID_QUERY",
          "Use an explicit null predicate",
          422,
        );
      try {
        normalizeCanonicalQueryOperand(
          field,
          String(f.op),
          f.value,
          `${field.key}.value`,
        );
      } catch {
        throw new ApiError(
          "INVALID_QUERY",
          "Query value does not match the canonical field/operator semantics",
          422,
        );
      }
    }
  }
  if (input.filter !== undefined) filter(input.filter);
  if (input.sort !== undefined) {
    if (
      !Array.isArray(input.sort) ||
      input.sort.length > m.snapshot.queryLimits.maxSort
    )
      throw new ApiError("INVALID_QUERY", "Invalid sort", 422);
    for (const raw of input.sort) {
      const s = objectInput(raw);
      onlyKeys(s, ["field", "direction"]);
      if (
        !m.snapshot.fields.some((f) => f.key === s.field && f.sortable) ||
        !["asc", "desc"].includes(String(s.direction))
      )
        throw new ApiError(
          "EXTERNAL_QUERY_UNSUPPORTED",
          "Sort is unavailable",
          422,
        );
    }
  }
  const page = input.page === undefined ? {} : objectInput(input.page);
  onlyKeys(page, ["limit", "cursor"]);
  const limit = page.limit ?? m.snapshot.queryLimits.maxPageSize;
  if (
    !Number.isInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > m.snapshot.queryLimits.maxPageSize
  )
    throw new ApiError("INVALID_QUERY", "Page limit must be 1-100", 422);
  if (page.cursor !== undefined) boundedString(page.cursor, "cursor", 8192);
  return { ...input, page: { ...page, limit } };
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function unbase64url(v: string) {
  return Uint8Array.from(
    atob(v.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
async function cursorKey(env: Bindings) {
  const secret =
    env.EXTERNAL_CURSOR_SECRET ??
    (env.ENVIRONMENT === "local" ? env.EXTERNAL_ADAPTER_SHARED_SECRET : undefined);
  if (!secret || secret.length < 32)
    throw new ExternalError("EXTERNAL_UNAVAILABLE", 503);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function encodeCursor(
  env: Bindings,
  m: ExternalModel,
  queryHash: string,
  providerCursor: string,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      space: m.space_id,
      model: m.model_key,
      schema: m.schema_hash,
      query: queryHash,
      cursor: providerCursor,
    }),
  );
  return (
    base64url(bytes) +
    "." +
    base64url(
      new Uint8Array(
        await crypto.subtle.sign("HMAC", await cursorKey(env), bytes),
      ),
    )
  );
}
async function decodeCursor(
  env: Bindings,
  m: ExternalModel,
  queryHash: string,
  cursor: string,
) {
  try {
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra) throw Error();
    const bytes = unbase64url(payload);
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await cursorKey(env),
        unbase64url(signature),
        bytes,
      ))
    )
      throw Error();
    const c = JSON.parse(new TextDecoder().decode(bytes));
    if (
      c.space !== m.space_id ||
      c.model !== m.model_key ||
      c.schema !== m.schema_hash ||
      c.query !== queryHash ||
      typeof c.cursor !== "string" ||
      c.cursor.length > 2048
    )
      throw Error();
    return c.cursor;
  } catch {
    throw new ApiError(
      "CURSOR_INVALID",
      "External cursor is stale or invalid",
      400,
    );
  }
}
export async function externalRecordDto(m: ExternalModel, raw: unknown) {
  const r = objectInput(raw),
    data = objectInput(r.data);
  boundedString(r.id, "recordId");
  if (typeof r.id !== "string" || !/^rec_external_[A-Za-z0-9_-]+$/.test(r.id)) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  const normalizedData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const field = m.snapshot.fields.find((candidate) => candidate.key === key);
    if (!field) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    try {
      normalizedData[key] = normalizeCanonicalFieldValue(field.key, field, value);
    } catch {
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    }
  }
  if (m.snapshot.fields.some((field) => !(field.key in data)))
    throw new ExternalError("EXTERNAL_SCHEMA_CHANGED", 409);
  return {
    id: r.id,
    spaceId: m.space_id,
    modelKey: externalBusinessKey(m),
    origin: "external",
    schemaHash: m.schema_hash,
    ...normalizedData,
    ...(typeof r.createdAt === "string" ? { createdAt: r.createdAt } : {}),
    ...(typeof r.updatedAt === "string" ? { updatedAt: r.updatedAt } : {}),
  };
}
export type ExternalAuditContext = {
  auditId: string;
  deferReadConsumption?: boolean;
  finalizers: D1PreparedStatement[];
};
export function externalAuditPlan(
  env: Bindings,
  m: ExternalModel,
  decision: ModelAccessDecision,
  operation: string,
  recordId?: string,
  bulkId?: string,
) {
  const auditId = "eoa_" + crypto.randomUUID().replaceAll("-", "");
  const p = decision.principal,
    actor = p.actor ?? { type: p.type, id: p.id };
  return {
    auditId,
    statement: env.DB.prepare(
      `INSERT INTO external_operation_audit(id,space_id,model_key,record_id,application_id,principal_type,principal_id,actor_type,actor_id,delegation_id,delegation_chain_json,operation,result,bulk_id,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`,
    ).bind(
      auditId,
      m.space_id,
      m.model_key,
      recordId ?? null,
      p.clientId,
      p.type,
      p.id,
      actor.type,
      actor.id,
      decision.authority.delegationId,
      JSON.stringify(decision.authority.delegationChain),
      operation,
      bulkId ?? null,
      new Date().toISOString(),
    ),
  };
}
export async function executeExternalOperation(
  env: Bindings,
  model: ExternalModel,
  decision: ModelAccessDecision,
  operation: Exclude<ExternalOperation, "connection" | "discover">,
  input: Record<string, unknown>,
  recordId?: string,
  bulkId?: string,
  auditContext?: ExternalAuditContext,
): Promise<unknown> {
  let m = model;
  const write =
    operation === "create" || operation === "update" || operation === "delete";
  if (write && decision.authority.singleUse)
    throw new ApiError(
      "EXTERNAL_SINGLE_USE_UNSUPPORTED",
      "External writes cannot atomically consume single-use Delegation",
      422,
    );
  if (
    !m.snapshot.capabilities[operation] ||
    (write && m.declared_access !== "write")
  )
    throw new ApiError(
      "MODEL_OPERATION_UNSUPPORTED",
      "External operation is unavailable",
      405,
    );
  const plan = auditContext
    ? null
    : externalAuditPlan(env, m, decision, operation, recordId, bulkId);
  const auditId = auditContext?.auditId ?? plan!.auditId;
  if (plan)
    try {
      await plan.statement.run();
    } catch {
      throw new ApiError(
        "EXTERNAL_AUDIT_UNAVAILABLE",
        "Provider execution did not start because pending audit could not be persisted",
        503,
      );
    }
  let providerSucceeded = false;
  try {
    let queryHash = "";
    const prepare = async () => {
      if (operation === "create" || operation === "update")
        return validateData(m, input, operation);
      if (operation !== "query") return input;
      const q = validateQuery(m, input);
      const page = objectInput(q.page);
      const { cursor, ...pagination } = page;
      queryHash = await externalHash({ ...q, page: pagination });
      return {
        ...q,
        page: {
          ...pagination,
          ...(cursor
            ? { cursor: await decodeCursor(env, m, queryHash, String(cursor)) }
            : {}),
        },
      };
    };
    let prepared = await prepare();
    let result: unknown;
    try {
      result = await callExternalAdapter(
        env,
        m.source,
        operation,
        m.resource_id,
        m.snapshot,
        prepared,
        recordId,
      );
    } catch (error) {
      if (
        !(error instanceof ExternalError) ||
        error.code !== "EXTERNAL_SCHEMA_CHANGED" ||
        !error.retrySafe
      )
        throw error;
      m = await refreshExternalModel(env, m);
      if (
        !m.snapshot.capabilities[operation] ||
        (write && m.declared_access !== "write")
      )
        throw new ApiError(
          "MODEL_OPERATION_UNSUPPORTED",
          "External operation is unavailable",
          405,
        );
      prepared = await prepare();
      result = await callExternalAdapter(
        env,
        m.source,
        operation,
        m.resource_id,
        m.snapshot,
        prepared,
        recordId,
      );
    }
    providerSucceeded = true;
    let response: unknown;
    if (operation === "query") {
      const r = objectInput(result);
      if (!Array.isArray(r.items) || r.items.length > 100)
        throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
      const items = await Promise.all(
        r.items.map((i) => externalRecordDto(m, i)),
      );
      if (r.nextCursor !== null && typeof r.nextCursor !== "string")
        throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
      response = {
        items,
        nextCursor: r.nextCursor
          ? await encodeCursor(
              env,
              m,
              queryHash,
              boundedString(r.nextCursor, "providerCursor", 2048),
            )
          : null,
      };
    } else if (operation === "delete") response = { id: recordId };
    else response = await externalRecordDto(m, result);
    if (recordId && operation !== "query" && operation !== "create" && objectInput(result).id !== recordId) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    if (!write && !auditContext?.deferReadConsumption) await consumeSingleUseRead(env, decision);
    const identityRecords =
      operation === "query"
        ? (response as { items: { id: string }[] }).items
        : operation === "delete"
          ? []
          : [response as { id: string }];
    const finalizers = [
      ...(operation === "delete" ? [env.DB.prepare("DELETE FROM external_record_identities WHERE record_id=? AND model_key=? AND space_id=?").bind(recordId, m.model_key, m.space_id)] : []),
      ...identityRecords.map((r) =>
        env.DB.prepare(
          "INSERT INTO external_record_identities(record_id,model_key,space_id,availability,observed_at,next_check_at) VALUES(?,?,?,'active',?,?) ON CONFLICT(record_id) DO UPDATE SET availability='active',observed_at=excluded.observed_at,next_check_at=excluded.next_check_at WHERE model_key=excluded.model_key AND space_id=excluded.space_id",
        ).bind(r.id, m.model_key, m.space_id, new Date().toISOString(), m.businessDefinition ? nextExternalRefresh(env) : null),
      ),
      env.DB.prepare(
        "UPDATE external_operation_audit SET result='succeeded',record_id=?,completed_at=? WHERE id=?",
      ).bind(
        recordId ?? (response as { id?: string })?.id ?? null,
        new Date().toISOString(),
        auditId,
      ),
    ];
    if (auditContext) auditContext.finalizers.push(...finalizers);
    else await env.DB.batch(finalizers);
    return response;
  } catch (error) {
    const code =
      error instanceof ApiError ? error.code : "EXTERNAL_WRITE_UNKNOWN";
    const unknown =
      write &&
      (providerSucceeded ||
        !(error instanceof ApiError) ||
        [
          "EXTERNAL_WRITE_UNKNOWN",
          "EXTERNAL_TIMEOUT",
          "EXTERNAL_UNAVAILABLE",
          "EXTERNAL_CONTRACT_INVALID",
        ].includes(code));
    const failure = env.DB.prepare(
      "UPDATE external_operation_audit SET result=?,error_code=?,completed_at=? WHERE id=?",
    ).bind(
      unknown ? "unknown" : "failed",
      code,
      new Date().toISOString(),
      auditId,
    );
    if (auditContext) auditContext.finalizers.push(failure);
    else await failure.run().catch(() => undefined);
    if (
      ["EXTERNAL_ACCESS_DENIED", "EXTERNAL_RESOURCE_UNAVAILABLE"].includes(code)
    ) {
      const degraded = env.DB.prepare(
        "UPDATE external_models SET status='degraded',last_error_code=? WHERE model_key=? AND status!='disabled'",
      )
        .bind(code, m.model_key);
      if (auditContext) auditContext.finalizers.push(degraded);
      else await degraded.run();
    }
    if (unknown) throw new ExternalError("EXTERNAL_WRITE_UNKNOWN", 502);
    throw error;
  }
}
export async function resolveExternalRecords(
  env: Bindings,
  model: ExternalModel,
  decision: ModelAccessDecision,
  ids: readonly string[],
) {
  if (ids.length > 100)
    throw new ApiError("INVALID_REQUEST", "Resolution budget exceeded", 400);
  ids = [...new Set(ids)];
  const checks = await evaluateModelAccessMany(
    env,
    decision.principal,
    model.space_id,
    ids.map((id) => ({
      model: externalAuthorityModel(model),
      required: "read",
      selector: { recordId: id, delegationId: decision.authority.delegationId },
    })),
  );
  const result = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += 3)
    await Promise.all(
      ids.slice(i, i + 3).map(async (id) => {
        try {
          const check = checks[ids.indexOf(id)]!;
          if (!check.ok) throw check.error;
          result.set(
            id,
            await executeExternalOperation(
              env,
              model,
              check.decision,
              "get",
              {},
              id,
            ),
          );
        } catch (error) {
          if (error instanceof ApiError && [403, 404].includes(error.status))
            result.set(id, { id, available: false });
          else throw error;
        }
      }),
    );
  return result;
}
export function registerExternalRuntimeRoutes(app: App) {
  const collection = "/api/v1/spaces/:spaceId/models/:modelKey/records";
  const handler = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const key = c.req.param("modelKey")!;
    if (!(await isExternalModelAddress(c.env, key))) {
      await next();
      return;
    }
    const m = await getExternalModel(c.env, c.req.param("spaceId")!, key);
    if (!m) throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
    const tail = new URL(c.req.url).pathname.split("/records")[1] ?? "";
    const method = c.req.method;
    const op: Exclude<ExternalOperation, "connection" | "discover"> | null =
      tail === "/query" && method === "POST"
        ? "query"
        : tail === ""
          ? method === "GET"
            ? "query"
            : method === "POST"
              ? "create"
              : null
          : /^\/[^/]+$/.test(tail)
            ? method === "GET"
              ? "get"
              : method === "PATCH"
                ? "update"
                : method === "DELETE"
                  ? "delete"
                  : null
            : null;
    if (!op)
      throw new ApiError(
        "MODEL_OPERATION_UNSUPPORTED",
        "External operation is unavailable",
        405,
      );
    const recordId = ["get", "update", "delete"].includes(op)
      ? decodeURIComponent(tail.slice(1))
      : undefined;
    const access = await requireModelAccess(
      c.env,
      c.get("principal"),
      m.space_id,
      externalAuthorityModel(m),
      ["get", "query"].includes(op) ? "read" : "write",
      { delegationId: c.req.header("x-lifespace-delegation-id"), recordId },
    );
    let input: Record<string, unknown> = {};
    if (method !== "GET")
      input = objectInput(await c.req.json<unknown>().catch(() => null));
    else if (op === "query") {
      const params = new URL(c.req.url).searchParams;
      for (const k of params.keys())
        if (!["limit", "cursor"].includes(k))
          throw new ApiError(
            "EXTERNAL_QUERY_UNSUPPORTED",
            "Use the canonical typed query operation",
            422,
          );
      input = {
        page: {
          ...(params.has("limit")
            ? { limit: Number(params.get("limit")) }
            : {}),
          ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}),
        },
      };
    }
    if ("version" in input)
      throw new ApiError(
        "EXTERNAL_VERSION_UNSUPPORTED",
        "External model has no conditional version write",
        422,
      );
    if (op === "delete") onlyKeys(input, []);
    if (op === "update" && !Object.keys(input).length)
      throw new ApiError("INVALID_REQUEST", "A field change is required", 400);
    const result = await executeExternalOperation(
      c.env,
      m,
      access,
      op,
      input,
      recordId,
    );
    if (op === "delete") return c.body(null, 204);
    return c.json(success(result), op === "create" ? 201 : 200);
  };
  app.use(collection, handler);
  app.use(collection + "/*", handler);
}
import type { Hono, MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "./env";
import { ApiError, success } from "./http";
import { evaluateModelAccessMany } from "./model-authorization";
import {
  externalAuthorityModel,
  getExternalModel,
  isExternalModelKey,
  isExternalModelAddress,
  externalBusinessKey,
  objectInput,
  onlyKeys,
  resolveSpaceAuthorityModel,
  listExternalModels,
  type ExternalModel,
} from "./external-model";
import {
  executeExternalOperation,
  externalAuditPlan,
} from "./external-runtime";
type AppEnv = { Bindings: Bindings; Variables: Variables };
export function registerExternalBatchRoutes(app: Hono<AppEnv>) {
  const handler: MiddlewareHandler<AppEnv> = async (c, next) => {
    const raw = await c.req.json<unknown>().catch(() => null);
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      !Array.isArray((raw as { operations?: unknown }).operations)
    ) {
      await next();
      return;
    }
    const input = raw as { operations: Record<string, unknown>[] };
    const externalKeys = new Set<string>();
    for (const key of new Set(input.operations.map(op => String(op?.modelKey ?? "")))) {
      if (await isExternalModelAddress(c.env, key)) externalKeys.add(key);
    }
    if (!externalKeys.size) { await next(); return; }
    const unified = new URL(c.req.url).pathname.endsWith("/batch");
    onlyKeys(input, unified ? ["operations", "atomicConsistency", "delegationId"] : ["operations"]);
    if (unified && (raw as { atomicConsistency?: unknown }).atomicConsistency !== false)
      throw new ApiError("EXTERNAL_ATOMIC_UNSUPPORTED", "External models require atomicConsistency=false", 422);

    const selected = (raw as { delegationId?: unknown }).delegationId ?? c.req.header("x-lifespace-delegation-id") ?? null;
    if (selected !== null && (typeof selected !== "string" || !/^dlg_[A-Za-z0-9_-]+$/.test(selected)))
      throw new ApiError("INVALID_REQUEST", "Invalid delegationId", 400);
    for (const op of input.operations) if (op && typeof op === "object" && op.delegationId === undefined && selected !== null) op.delegationId = selected;
    if (input.operations.length < 1 || input.operations.length > 20)
      throw new ApiError("INVALID_REQUEST", "Bulk supports 1-20 items", 400);
    if (unified && input.operations.some(op => ["relation_create", "relation_delete"].includes(String(op?.operation)))) {
      for (const op of input.operations) objectInput(op);
      const leaves = new Set(input.operations.map(op => op.delegationId ?? null));
      if (leaves.size > 1) throw new ApiError("DELEGATION_INVALID", "Mixed Provider/edge batch requires one request-wide Delegation", 403);
      const records = input.operations.flatMap((op, index) => ["relation_create", "relation_delete"].includes(String(op?.operation)) ? [] : [{ op, index }]);
      const relations = input.operations.flatMap((op, index) => ["relation_create", "relation_delete"].includes(String(op?.operation)) ? [{ op, index }] : []);
      const refs = new Map<string, number>();
      for (const { op, index } of records) {
        if (op.semanticRelations !== undefined) throw new ApiError("MODEL_OPERATION_UNSUPPORTED", "Use independent relation_create for Provider batches", 422);
        if (op.clientRef !== undefined) {
          if (op.operation !== "create" || typeof op.clientRef !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,62}$/.test(op.clientRef) || refs.has(op.clientRef)) throw new ApiError("INVALID_REQUEST", "Invalid or duplicate clientRef", 400);
          refs.set(op.clientRef, index);
        }
      }
      // Resolve only request-local create refs; never infer model identity from a label.
      for (const { op } of relations) for (const rawRef of [op.source, op.target]) {
        if (!rawRef || typeof rawRef !== "object") continue;
        const ref = rawRef as Record<string, unknown>;
        if (ref.clientRef !== undefined) {
          const index = typeof ref.clientRef === "string" ? refs.get(ref.clientRef) : undefined;
          if (index === undefined || input.operations[index]!.modelKey !== ref.modelKey || ref.recordId !== undefined) throw new ApiError("INVALID_REQUEST", "clientRef must refer to a create of the stated model", 400);
        }
        if (records.some(({ op: record }) => ["update", "delete"].includes(String(record.operation)) && record.recordId === ref.recordId && record.modelKey === ref.modelKey)) throw new ApiError("INVALID_REQUEST", "Relation endpoints cannot also be updated/deleted in this batch", 400);
      }
      const requestPart = async (operations: Record<string, unknown>[]) => {
        const response = await app.request(c.req.url, { method: "POST", headers: c.req.raw.headers,
          body: JSON.stringify({ atomicConsistency: false, operations, ...(selected ? { delegationId: selected } : {}) }) }, c.env);
        const payload = await response.json() as { data?: { items: Record<string, unknown>[]; bulkId?: string }; error?: { code: string; message: string } };
        if (!response.ok) throw new ApiError(payload.error?.code ?? "INVALID_REQUEST", payload.error?.message ?? "Batch part failed", response.status as 400);
        return payload.data!;
      };
      const recordResult = await requestPart(records.map(({ op }) => { const { clientRef: _ref, ...body } = op; return body; }));
      const items: Record<string, unknown>[] = Array(input.operations.length);
      records.forEach(({ index }, offset) => { items[index] = { ...recordResult.items[offset], index }; });
      const ready: { op: Record<string, unknown>; index: number }[] = [];
      for (const { op, index } of relations) {
        const copy = structuredClone(op); let failed = false;
        for (const side of ["source", "target"]) {
          const ref = copy[side] as Record<string, unknown> | undefined;
          if (ref?.clientRef !== undefined) {
            const result = items[refs.get(String(ref.clientRef))!]!;
            if (result.status !== "succeeded" || typeof result.recordId !== "string") { failed = true; break; }
            ref.recordId = result.recordId; delete ref.clientRef;
          }
        }
        if (failed) items[index] = { index, operation: op.operation, modelKey: null, status: "failed", error: { code: "BATCH_DEPENDENCY_FAILED", message: "Referenced create did not succeed", status: 400 } };
        else ready.push({ op: copy, index });
      }
      let relationBulkId: string | undefined;
      if (ready.length) {
        try {
          const result = await requestPart(ready.map(r => r.op)); relationBulkId = result.bulkId;
          ready.forEach(({ index }, offset) => { items[index] = { ...result.items[offset], index }; });
        } catch (error) {
          const failure = error instanceof ApiError ? error : new ApiError("EXTERNAL_UNAVAILABLE", "Relation execution unavailable", 503);
          ready.forEach(({ index, op }) => { items[index] = { index, operation: op.operation, modelKey: null, status: "failed", error: { code: failure.code, message: failure.message, status: failure.status } }; });
        }
      }
      return c.json(success({ bulkId: recordResult.bulkId, relationBulkId, atomicConsistency: false, succeededCount: items.filter(i => i.status === "succeeded").length,
        failedCount: items.filter(i => i.status !== "succeeded").length, items }));
    }
    const space = c.req.param("spaceId")!;
    const principal = c.get("principal");
    const bulkId = "blk_" + crypto.randomUUID().replaceAll("-", "");
    const externalCatalog = new Map(
      (await listExternalModels(c.env, [space])).flatMap((m) => [[m.model_key, m] as const, [externalBusinessKey(m), m] as const]),
    );
    const resolved = await Promise.all(
      input.operations.map(async (op) => {
        try {
          objectInput(op);
          if (typeof op.modelKey !== "string")
            throw new ApiError("INVALID_REQUEST", "modelKey is required", 400);
          return externalKeys.has(op.modelKey)
            ? externalCatalog.has(op.modelKey)
              ? externalAuthorityModel(externalCatalog.get(op.modelKey)!)
              : null
            : await resolveSpaceAuthorityModel(c.env, space, op.modelKey);
        } catch {
          return null;
        }
      }),
    );
    // Resolve one consistent execution context before any provider/native mutation.
    const candidates = input.operations.flatMap((op, i) =>
      resolved[i] ? [{ index: i, op, model: resolved[i]! }] : [],
    );
    const checks = await evaluateModelAccessMany(
      c.env,
      principal,
      space,
      candidates.map((x) => ({
        model: x.model,
        required: "write",
        selector: {
          delegationId:
            typeof x.op.delegationId === "string" ? x.op.delegationId : null,
          recordId: typeof x.op.recordId === "string" ? x.op.recordId : null,
        },
      })),
    );
    const decisions = new Map(candidates.map((x, i) => [x.index, checks[i]!]));
    const valid = checks.flatMap((x) => (x.ok ? [x.decision] : []));
    const first = valid[0]?.principal;
    if (
      first &&
      valid.some(
        (x) =>
          x.principal.id !== first.id ||
          x.principal.type !== first.type ||
          x.principal.actor?.id !== first.actor?.id,
      )
    )
      throw new ApiError(
        "DELEGATION_INVALID",
        "Bulk must use one Execution Principal",
        403,
      );
    const items: Record<string, unknown>[] = Array(input.operations.length);
    const native: { index: number; op: Record<string, unknown> }[] = [];
    for (let i = 0; i < input.operations.length; i++) {
      const op = input.operations[i]!;
      if (
        op &&
        typeof op.modelKey === "string" &&
        !externalKeys.has(op.modelKey)
      )
        native.push({ index: i, op });
    }
    let nativeBulkId: string | undefined;
    if (native.length) {
      const response = await app.request(
        c.req.url.replace(/\/(batch|bulk)$/, "/batch"),
        {
          method: "POST",
          headers: c.req.raw.headers,
          body: JSON.stringify({ atomicConsistency: false, operations: native.map((x) => x.op) }),
        },
        c.env,
      );
      const data = (await response.json()) as {
        data?: { bulkId: string; items: Record<string, unknown>[] };
        error?: { code: string; message: string };
      };
      if (!response.ok)
        throw new ApiError(
          data.error?.code ?? "INVALID_REQUEST",
          data.error?.message ?? "Native Bulk rejected",
          response.status as 400,
        );
      nativeBulkId = data.data!.bulkId;
      for (let n = 0; n < native.length; n++)
        items[native[n]!.index] = {
          ...data.data!.items[n],
          index: native[n]!.index,
        };
    }
    const externalIndexes = input.operations.flatMap((op, i) =>
      !native.some((n) => n.index === i) ? [i] : [],
    );
    const seen = new Set<string>();
    // Reserve duplicate targets before fan-out, preserving deterministic per-item denial.
    const duplicate = new Set<number>();
    for (const i of externalIndexes) {
      const op = input.operations[i]!;
      if (op && typeof op.recordId === "string") {
        const target = String(op.modelKey) + "/" + op.recordId;
        if (seen.has(target)) duplicate.add(i);
        seen.add(target);
      }
    }
    const finalizers: D1PreparedStatement[] = [];
    const auditPlans = new Map<number, ReturnType<typeof externalAuditPlan>>();
    for (const i of externalIndexes) {
      const op = input.operations[i]!,
        check = decisions.get(i),
        m = externalCatalog.get(String(op?.modelKey));
      if (
        check?.ok &&
        m &&
        ["create", "update", "delete"].includes(String(op.operation))
      )
        auditPlans.set(
          i,
          externalAuditPlan(
            c.env,
            m,
            check.decision,
            String(op.operation),
            typeof op.recordId === "string" ? op.recordId : undefined,
            bulkId,
          ),
        );
    }
    if (auditPlans.size)
      try {
        await c.env.DB.batch([...auditPlans.values()].map((p) => p.statement));
      } catch {
        for (const i of externalIndexes)
          items[i] = {
            index: i,
            modelKey: input.operations[i]?.modelKey ?? null,
            operation: input.operations[i]?.operation ?? null,
            status: "failed",
            error: {
              code: "EXTERNAL_AUDIT_UNAVAILABLE",
              message:
                "Provider execution did not start because pending audit could not be persisted",
              status: 503,
            },
          };
        return c.json(
          success({ bulkId, ...(nativeBulkId ? { nativeBulkId } : {}), items }),
        );
      }
    for (let offset = 0; offset < externalIndexes.length; offset += 3)
      await Promise.all(
        externalIndexes.slice(offset, offset + 3).map(async (i) => {
          const op = input.operations[i]!;
          try {
            objectInput(op);
            if (!["create", "update", "delete"].includes(String(op.operation)))
              throw new ApiError(
                "INVALID_REQUEST",
                "Unsupported bulk operation",
                400,
              );
            onlyKeys(
              op,
              op.operation === "create"
                ? ["operation", "modelKey", "data", "delegationId"]
                : op.operation === "update"
                  ? [
                      "operation",
                      "modelKey",
                      "recordId",
                      "data",
                      "delegationId",
                      "version",
                    ]
                  : [
                      "operation",
                      "modelKey",
                      "recordId",
                      "delegationId",
                      "version",
                    ],
            );
            if (op.version !== undefined && op.version !== null)
              throw new ApiError(
                "EXTERNAL_VERSION_UNSUPPORTED",
                "External model has no conditional version write",
                422,
              );
            if (duplicate.has(i))
              throw new ApiError(
                "INVALID_REQUEST",
                "Duplicate bulk target",
                400,
              );
            const check = decisions.get(i);
            if (!check)
              throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
            if (!check.ok) throw check.error;
            const m = externalCatalog.get(String(op.modelKey));
            if (!m)
              throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
            const recordId =
              op.operation === "create"
                ? undefined
                : typeof op.recordId === "string"
                  ? op.recordId
                  : undefined;
            if (op.operation !== "create" && !recordId)
              throw new ApiError(
                "INVALID_REQUEST",
                "recordId is required",
                400,
              );
            const result = (await executeExternalOperation(
              c.env,
              m,
              check.decision,
              op.operation as "create" | "update" | "delete",
              op.operation === "delete" ? {} : objectInput(op.data),
              recordId,
              bulkId,
              { auditId: auditPlans.get(i)!.auditId, finalizers },
            )) as { id?: string };
            items[i] = {
              index: i,
              modelKey: op.modelKey,
              operation: op.operation,
              status: "succeeded",
              recordId: result.id ?? recordId,
            };
          } catch (error) {
            const e =
              error instanceof ApiError
                ? error
                : new ApiError(
                    "EXTERNAL_WRITE_UNKNOWN",
                    "External outcome is unknown",
                    502,
                  );
            if (auditPlans.has(i))
              finalizers.push(
                c.env.DB.prepare(
                  "UPDATE external_operation_audit SET result=?,error_code=?,completed_at=? WHERE id=?",
                ).bind(
                  e.code === "EXTERNAL_WRITE_UNKNOWN" ? "unknown" : "failed",
                  e.code,
                  new Date().toISOString(),
                  auditPlans.get(i)!.auditId,
                ),
              );
            items[i] = {
              index: i,
              modelKey: op?.modelKey ?? null,
              operation: op?.operation ?? null,
              status:
                e.code === "EXTERNAL_WRITE_UNKNOWN" ? "unknown" : "failed",
              error: { code: e.code, message: e.message, status: e.status },
            };
          }
        }),
      );
    if (finalizers.length)
      try {
        await c.env.DB.batch(finalizers);
      } catch {
        for (const i of externalIndexes)
          if (items[i]?.status === "succeeded")
            items[i] = {
              ...items[i],
              status: "unknown",
              error: {
                code: "EXTERNAL_WRITE_UNKNOWN",
                message:
                  "Provider outcome could not be finalized in local audit",
                status: 502,
              },
            };
      }
    return c.json(
      success({ bulkId, ...(nativeBulkId ? { nativeBulkId } : {}), items }),
    );
  };
  app.use("/api/v1/spaces/:spaceId/models/batch", handler);
  app.use("/api/v1/spaces/:spaceId/models/bulk", handler);
}

import type { Bindings } from "./env";
import { ApiError } from "./http";
import type { ModelAccess } from "./model-definition";
import { getRuntimeModel, type PublishedModel } from "./model-registry";

export const EXTERNAL_PREFIX = "ext_";
export const isExternalModelKey = (key: string) =>
  key.startsWith(EXTERNAL_PREFIX);
export async function isExternalModelAddress(env: Bindings, key: string): Promise<boolean> {
  return isExternalModelKey(key) || (await getRuntimeModel(env, key))?.definition.origin === "external";
}
export const externalBusinessKey = (model: ExternalModel) => model.definition_key ?? model.model_key;
export type ExternalCapabilities = {
  get: boolean;
  query: boolean;
  create: boolean;
  update: boolean;
  delete: boolean;
  batchWrite: boolean;
  atomicBatch: false;
  transaction: false;
  versionedWrite: false;
  actions: false;
  relationTargetResolution: boolean;
};
export type ExternalField = {
  key: string;
  sourceFieldId: string;
  title: string;
  type: "string" | "text" | "number" | "boolean" | "enum" | "instant";
  nullable: boolean;
  readable: true;
  writable: boolean;
  operators: string[];
  sortable: boolean;
  values?: string[];
};
export type ExternalSnapshot = {
  resourceId: string;
  displayName: string;
  fields: ExternalField[];
  capabilities: ExternalCapabilities;
  queryLimits: {
    maxDepth: number;
    maxNodes: number;
    maxSort: number;
    maxPageSize: number;
  };
  adapterState: Record<string, unknown>;
};
export type ExternalSource = {
  id: string;
  space_id: string;
  provider_key: string;
  credential_ref: string;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};
export type ExternalModelRow = {
  definition_key?: string | null;
  model_key: string;
  space_id: string;
  source_id: string;
  provider_key: string;
  resource_id: string;
  display_name: string;
  declared_access: "read" | "write";
  snapshot_json: string;
  schema_hash: string;
  schema_observed_at: string;
  status: "active" | "disabled" | "degraded";
  last_successful_refresh_at: string;
  last_error_code: string | null;
  next_refresh_at: string | null;
  created_at: string;
  updated_at: string;
};
export type ExternalModel = ExternalModelRow & {
  snapshot: ExternalSnapshot;
  source: ExternalSource;
  businessDefinition?: PublishedModel;
};
export type ExternalOperation =
  | "connection"
  | "discover"
  | "get"
  | "query"
  | "create"
  | "update"
  | "delete";
export class ExternalError extends ApiError {
  constructor(
    code: string,
    status: 400 | 404 | 409 | 422 | 429 | 502 | 503,
    public retrySafe = false,
  ) {
    super(code, "External operation could not be completed", status);
  }
}
const errorStatus: Record<string, 400 | 404 | 409 | 422 | 429 | 502 | 503> = {
  EXTERNAL_UNAVAILABLE: 503,
  EXTERNAL_ACCESS_DENIED: 503,
  EXTERNAL_RESOURCE_UNAVAILABLE: 404,
  EXTERNAL_RATE_LIMITED: 429,
  EXTERNAL_SCHEMA_CHANGED: 409,
  EXTERNAL_QUERY_UNSUPPORTED: 422,
  EXTERNAL_VALIDATION_FAILED: 422,
  EXTERNAL_WRITE_UNKNOWN: 502,
  EXTERNAL_TIMEOUT: 503,
  EXTERNAL_CONTRACT_INVALID: 502,
};
export function canonicalExternalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalExternalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalExternalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function externalHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalExternalJson(value)),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError("INVALID_REQUEST", "An object is required", 400);
  return value as Record<string, unknown>;
}
export function onlyKeys(
  input: Record<string, unknown>,
  keys: readonly string[],
) {
  if (Object.keys(input).some((k) => !keys.includes(k)))
    throw new ApiError("INVALID_REQUEST", "Unsupported request field", 400);
}
export function boundedString(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max)
    throw new ApiError("VALIDATION_ERROR", `${name} is invalid`, 422);
  return value;
}
export function validateExternalSnapshot(value: unknown): ExternalSnapshot {
  const input = objectInput(value);
  onlyKeys(input, [
    "resourceId",
    "displayName",
    "fields",
    "capabilities",
    "adapterState",
    "queryLimits",
  ]);
  boundedString(input.resourceId, "resourceId");
  boundedString(input.displayName, "displayName");
  if (!Array.isArray(input.fields) || input.fields.length > 100)
    throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  const seen = new Set<string>();
  const ids = new Set<string>();
  for (const raw of input.fields) {
    const f = objectInput(raw);
    onlyKeys(f, [
      "key",
      "sourceFieldId",
      "title",
      "type",
      "nullable",
      "readable",
      "writable",
      "operators",
      "sortable",
      "values",
    ]);
    if (
      typeof f.key !== "string" ||
      !/^f_[a-f0-9]{32}$/.test(f.key) ||
      seen.has(f.key)
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    seen.add(f.key);
    const id = boundedString(f.sourceFieldId, "sourceFieldId");
    if (ids.has(id)) throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    ids.add(id);
    boundedString(f.title, "title");
    if (
      !["string", "text", "number", "boolean", "enum", "instant"].includes(
        String(f.type),
      ) ||
      f.readable !== true ||
      typeof f.writable !== "boolean" ||
      typeof f.sortable !== "boolean" ||
      typeof f.nullable !== "boolean"
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    if (
      !Array.isArray(f.operators) ||
      f.operators.some(
        (op) =>
          ![
            "eq",
            "ne",
            "lt",
            "lte",
            "gt",
            "gte",
            "contains",
            "isNull",
            "isNotNull",
          ].includes(String(op)),
      )
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    if (
      f.type === "enum" &&
      (!Array.isArray(f.values) ||
        !f.values.length ||
        f.values.length > 100 ||
        f.values.some(
          (v) => typeof v !== "string" || !v.length || v.length > 256,
        ))
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  }
  const caps = objectInput(input.capabilities);
  onlyKeys(caps, [
    "get",
    "query",
    "create",
    "update",
    "delete",
    "batchWrite",
    "atomicBatch",
    "transaction",
    "versionedWrite",
    "actions",
    "relationTargetResolution",
  ]);
  for (const k of ["get", "query", "create", "update", "delete", "batchWrite", "relationTargetResolution"])
    if (typeof caps[k] !== "boolean")
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  for (const k of [
    "atomicBatch",
    "transaction",
    "versionedWrite",
    "actions",
  ])
    if (caps[k] !== false)
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  const limits = objectInput(input.queryLimits);
  onlyKeys(limits, ["maxDepth", "maxNodes", "maxSort", "maxPageSize"]);
  for (const [key, max] of Object.entries({
    maxDepth: 8,
    maxNodes: 100,
    maxSort: 8,
    maxPageSize: 100,
  }))
    if (
      !Number.isInteger(limits[key]) ||
      Number(limits[key]) < 1 ||
      Number(limits[key]) > max
    )
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  objectInput(input.adapterState);
  if (canonicalExternalJson(input).length > 128000)
    throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  return input as unknown as ExternalSnapshot;
}
export async function callExternalAdapter(
  env: Bindings,
  source: ExternalSource,
  operation: ExternalOperation,
  resourceId: string,
  snapshot?: ExternalSnapshot,
  input?: Record<string, unknown>,
  recordId?: string,
): Promise<unknown> {
  if (
    !env.EXTERNAL_ADAPTER ||
    !env.EXTERNAL_ADAPTER_SHARED_SECRET ||
    env.EXTERNAL_ADAPTER_SHARED_SECRET.length < 32
  )
    throw new ExternalError("EXTERNAL_UNAVAILABLE", 503);
  let response: Response;
  try {
    response = await env.EXTERNAL_ADAPTER.fetch(
      "https://external-adapter.internal/internal/v1/external-models",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lifespace-internal-secret": env.EXTERNAL_ADAPTER_SHARED_SECRET,
        },
        body: JSON.stringify({
          contractVersion: 1,
          providerKey: source.provider_key,
          credentialRef: source.credential_ref,
          operation,
          resourceId,
          ...(snapshot ? { snapshot } : {}),
          ...(input ? { input } : {}),
          ...(recordId ? { recordId } : {}),
        }),
        signal: AbortSignal.timeout(30000),
      },
    );
  } catch {
    throw new ExternalError(
      ["create", "update", "delete"].includes(operation)
        ? "EXTERNAL_WRITE_UNKNOWN"
        : "EXTERNAL_UNAVAILABLE",
      503,
    );
  }
  const text = await response.text();
  if (text.length > 2_000_000)
    throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || "null");
  } catch {
    throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  }
  const body = parsed as {
    contractVersion?: number;
    data?: unknown;
    error?: { code?: string; retrySafe?: boolean };
  } | null;
  if (!body || body.contractVersion !== 1)
    throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
  if (!response.ok || body.error) {
    const code = body.error?.code;
    throw new ExternalError(
      code && errorStatus[code] ? code : "EXTERNAL_UNAVAILABLE",
      code && errorStatus[code] ? errorStatus[code]! : 503,
      body.error?.retrySafe === true,
    );
  }
  return body.data;
}
export async function getExternalSource(
  env: Bindings,
  id: string,
): Promise<ExternalSource | null> {
  return env.DB.prepare("SELECT * FROM external_sources WHERE id=?")
    .bind(id)
    .first<ExternalSource>();
}
async function rowModel(
  env: Bindings,
  row: ExternalModelRow,
  source: ExternalSource,
  includeDisabled = false,
): Promise<ExternalModel | null> {
  const definition = row.definition_key ? await getRuntimeModel(env, row.definition_key) : null;
  if (!includeDisabled && row.definition_key && definition?.definition.origin !== "external") return null;
  return {
    ...row,
    snapshot: validateExternalSnapshot(JSON.parse(row.snapshot_json)),
    source,
    ...(definition ? { businessDefinition: definition } : {}),
  };
}
export async function getExternalModel(
  env: Bindings,
  spaceId: string,
  key: string,
  includeDisabled = false,
): Promise<ExternalModel | null> {
  const row = await env.DB.prepare(
    "SELECT * FROM external_models WHERE space_id=? AND (model_key=? OR definition_key=?) ORDER BY (status!='disabled') DESC,updated_at DESC LIMIT 1",
  )
    .bind(spaceId, key, key)
    .first<ExternalModelRow>();
  if (!row || (!includeDisabled && row.status === "disabled")) return null;
  const source = await getExternalSource(env, row.source_id);
  if (!source || (!includeDisabled && source.status !== "active")) return null;
  return rowModel(env, row, source, includeDisabled);
}
export async function listExternalModels(
  env: Bindings,
  spaceIds: readonly string[],
): Promise<ExternalModel[]> {
  if (!env.EXTERNAL_ADAPTER || !spaceIds.length) return [];
  const items: ExternalModel[] = [];
  for (let i = 0; i < spaceIds.length; i += 80) {
    const group = spaceIds.slice(i, i + 80);
    const rows = await env.DB.prepare(
      `SELECT m.*,s.credential_ref,s.status source_status,s.created_at source_created_at,s.updated_at source_updated_at FROM external_models m JOIN external_sources s ON s.id=m.source_id WHERE m.space_id IN (${group.map(() => "?").join(",")}) AND m.status!='disabled' AND s.status='active'`,
    )
      .bind(...group)
      .all<
        ExternalModelRow & {
          credential_ref: string;
          source_status: "active";
          source_created_at: string;
          source_updated_at: string;
        }
      >();
    for (const r of rows.results) {
      const model = await rowModel(env, r, {
          id: r.source_id,
          space_id: r.space_id,
          provider_key: r.provider_key,
          credential_ref: r.credential_ref,
          status: r.source_status,
          created_at: r.source_created_at,
          updated_at: r.source_updated_at,
        });
      if (model) items.push(model);
    }
  }
  return items;
}
export function externalAuthorityModel(model: ExternalModel) {
  const access: ModelAccess[] =
    model.snapshot.capabilities.get || model.snapshot.capabilities.query
      ? ["read"]
      : [];
  if (
    model.declared_access === "write" &&
    [
      model.snapshot.capabilities.create,
      model.snapshot.capabilities.update,
      model.snapshot.capabilities.delete,
    ].some(Boolean)
  )
    access.push("write");
  const ceiling = model.businessDefinition?.definition.access;
  return { key: externalBusinessKey(model), definition: { access: ceiling ? access.filter(value => ceiling.includes(value)) : access } };
}
export async function resolveSpaceAuthorityModel(
  env: Bindings,
  spaceId: string,
  key: string,
) {
  if (await isExternalModelAddress(env, key)) {
    const model = await getExternalModel(env, spaceId, key);
    return model ? externalAuthorityModel(model) : null;
  }
  return getRuntimeModel(env, key);
}
export function schemaRefreshInterval(env: Bindings): number | null {
  const n = Number(env.EXTERNAL_SCHEMA_REFRESH_SECONDS);
  return Number.isInteger(n) && n >= 60 && n <= 86400 ? n : null;
}
export function nextExternalRefresh(env: Bindings): string | null {
  const interval = schemaRefreshInterval(env);
  return interval ? new Date(Date.now() + interval * 1000).toISOString() : null;
}
export async function refreshExternalModel(
  env: Bindings,
  model: ExternalModel,
): Promise<ExternalModel> {
  try {
    const snapshot = validateExternalSnapshot(
      await callExternalAdapter(
        env,
        model.source,
        "discover",
        model.resource_id,
      ),
    );
    if (snapshot.resourceId !== model.resource_id)
      throw new ExternalError("EXTERNAL_CONTRACT_INVALID", 502);
    const hash = await externalHash(snapshot);
    const now = new Date().toISOString();
    const r = await env.DB.prepare(
      `UPDATE external_models SET snapshot_json=?,schema_hash=?,schema_observed_at=?,display_name=?,status='active',last_successful_refresh_at=?,last_error_code=NULL,next_refresh_at=?,updated_at=? WHERE model_key=? AND status!='disabled' AND EXISTS(SELECT 1 FROM external_sources WHERE id=? AND status='active')`,
    )
      .bind(
        JSON.stringify(snapshot),
        hash,
        now,
        snapshot.displayName,
        now,
        nextExternalRefresh(env),
        now,
        model.model_key,
        model.source_id,
      )
      .run();
    if (!r.meta.changes) throw new ExternalError("EXTERNAL_UNAVAILABLE", 503);
    return {
      ...model,
      snapshot,
      snapshot_json: JSON.stringify(snapshot),
      schema_hash: hash,
      schema_observed_at: now,
      display_name: snapshot.displayName,
      status: "active",
      last_error_code: null,
    };
  } catch (error) {
    const code =
      error instanceof ExternalError ? error.code : "EXTERNAL_CONTRACT_INVALID";
    await env.DB.prepare(
      "UPDATE external_models SET status='degraded',last_error_code=?,next_refresh_at=?,updated_at=? WHERE model_key=? AND status!='disabled'",
    )
      .bind(
        code,
        nextExternalRefresh(env),
        new Date().toISOString(),
        model.model_key,
      )
      .run();
    throw error;
  }
}
async function reconcileExternalSchemas(env: Bindings): Promise<void> {
  if (!env.EXTERNAL_ADAPTER || !schemaRefreshInterval(env)) return;
  const rows = await env.DB.prepare(
    "SELECT space_id,model_key FROM external_models m WHERE status!='disabled' AND next_refresh_at IS NOT NULL AND next_refresh_at<=? AND EXISTS(SELECT 1 FROM external_sources s WHERE s.id=m.source_id AND s.status='active') AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=m.space_id AND s.deleted_at IS NULL) ORDER BY next_refresh_at,model_key LIMIT 20",
  )
    .bind(new Date().toISOString())
    .all<{ space_id: string; model_key: string }>();
  for (let i = 0; i < rows.results.length; i += 2)
    await Promise.all(
      rows.results.slice(i, i + 2).map(async (r) => {
        const model = await getExternalModel(env, r.space_id, r.model_key);
        if (model)
          await refreshExternalModel(env, model).catch(() => undefined);
      }),
    );
}

// This observes only Provider presence through the trusted connection. It does not
// exercise a user's data authority or publish Provider payload/attribution.
async function reconcileExternalIdentities(env: Bindings): Promise<void> {
  if (!env.EXTERNAL_ADAPTER || !schemaRefreshInterval(env)) return;
  const now = new Date().toISOString();
  const due = await env.DB.prepare(`SELECT i.record_id,i.model_key,i.space_id FROM external_record_identities i
    WHERE i.next_check_at IS NOT NULL AND i.next_check_at<=?
      AND EXISTS(SELECT 1 FROM external_models m JOIN external_sources s ON s.id=m.source_id JOIN model_definitions d ON d.model_key=m.definition_key AND d.state='published'
        WHERE m.model_key=i.model_key AND m.space_id=i.space_id AND json_extract(m.snapshot_json,'$.capabilities.get')=1 AND m.status!='disabled' AND s.status='active' AND json_extract(d.definition_json,'$.origin')='external')
      AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=i.space_id AND s.deleted_at IS NULL)
    ORDER BY i.next_check_at,i.record_id LIMIT 20`).bind(now).all<{ record_id: string; model_key: string; space_id: string }>();
  if (!due.results.length) return;
  const models = new Map((await listExternalModels(env, [...new Set(due.results.map(r => r.space_id))])).map(m => [m.model_key, m]));
  const updates: D1PreparedStatement[] = [];
  for (let offset = 0; offset < due.results.length; offset += 3) await Promise.all(due.results.slice(offset, offset + 3).map(async row => {
    const model = models.get(row.model_key); if (!model) return;
    let availability: string | null = null;
    try { const result = objectInput(await callExternalAdapter(env, model.source, "get", model.resource_id, model.snapshot, {}, row.record_id)); if (result.id === row.record_id && /^rec_external_[A-Za-z0-9_-]+$/.test(row.record_id)) availability = "active"; }
    catch (error) { if (error instanceof ApiError && error.code === "EXTERNAL_RESOURCE_UNAVAILABLE") availability = "unavailable"; }
    updates.push(env.DB.prepare(`UPDATE external_record_identities SET availability=COALESCE(?,availability),observed_at=?,next_check_at=? WHERE record_id=? AND model_key=? AND space_id=?
      AND EXISTS(SELECT 1 FROM external_models m JOIN external_sources s ON s.id=m.source_id WHERE m.model_key=? AND m.status!='disabled' AND s.status='active')`)
      .bind(availability, now, nextExternalRefresh(env), row.record_id, row.model_key, row.space_id, row.model_key));
  }));
  if (updates.length) await env.DB.batch(updates);
}
export async function reconcileExternalModels(env: Bindings): Promise<void> {
  const results = await Promise.allSettled([reconcileExternalSchemas(env), reconcileExternalIdentities(env)]);
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "External reconciliation failed");
}

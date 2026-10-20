import { AwsClient } from "aws4fetch";
import type { Context, Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { consumeSingleUseRead, requireModelAccess, type ModelAccessDecision } from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { getGenericResource } from "./generic-resource";
import { RECORD_ICON_FIELD, ICON_MAX_BYTES, validateRecordIconImage } from "./record-icon";
import {
  ExternalError,
  externalAuthorityModel,
  getExternalModel,
  isExternalModelAddress,
  type ExternalModel,
} from "./external-model";
import { executeExternalOperation } from "./external-runtime";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type Destination = "native" | "external";

const UPLOAD_TTL_SECONDS = 15 * 60;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const NATIVE_MAX_BYTES = 100 * 1024 * 1024;

export type UploadSessionRow = {
  id: string;
  space_id: string;
  model_key: string;
  field_key: string;
  record_id: string | null;
  destination: Destination;
  file_id: string | null;
  object_key: string;
  name: string;
  content_type: string;
  expected_size: number;
  status: "pending" | "executing" | "completed" | "failed" | "unknown" | "expired";
  error_code: string | null;
  application_id: string;
  principal_type: string;
  principal_id: string;
  actor_type: string;
  actor_id: string;
  expires_at: string;
  cleaned_at: string | null;
  created_at: string;
  completed_at: string | null;
};

type ResolvedTarget = {
  destination: Destination;
  maxBytes: number;
  decision: ModelAccessDecision;
  nativeModel?: PublishedModel;
  externalModel?: ExternalModel;
};

function object(value: unknown): Body {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  return value as Body;
}
function onlyKeys(input: Body, keys: readonly string[]) {
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new ApiError("INVALID_REQUEST", "Unsupported request field", 400);
}
function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new ApiError("VALIDATION_ERROR", `${label} is invalid`, 422);
  }
  return value.trim();
}
function actor(principal: Principal) { return principal.actor ?? { type: principal.type, id: principal.id }; }
function delegationId(context: Context<AppEnv>): string | null {
  return context.req.header("x-lifespace-delegation-id")?.trim() || null;
}
function bucket(env: Bindings): string {
  return env.R2_S3_BUCKET?.trim() || (env.ENVIRONMENT === "production" ? "lifespace-assets" : env.ENVIRONMENT === "staging" ? "lifespace-staging-assets" : "lifespace-local-assets");
}
function r2Signer(env: Bindings): { client: AwsClient; origin: string } {
  const accountId = env.R2_S3_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_S3_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey) throw new ApiError("FILE_TRANSFER_UNAVAILABLE", "File transfer signing is not configured", 503);
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto", retries: 0 }),
    origin: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}
function objectUrl(origin: string, bucketName: string, key: string): URL {
  const path = [bucketName, ...key.split("/")].map(encodeURIComponent).join("/");
  return new URL(`/${path}`, origin);
}
export async function presignR2Object(
  env: Bindings,
  key: string,
  method: "PUT" | "GET",
  ttlSeconds: number,
  contentType?: string,
): Promise<string> {
  // Never issue a writable bearer URL for a permanent LifeSpace File.
  if (method === "PUT" && !key.startsWith("uploads/")) {
    throw new ApiError("INVALID_REQUEST", "Only temporary upload objects are writable through presigned URLs", 400);
  }
  const { client, origin } = r2Signer(env);
  const url = objectUrl(origin, bucket(env), key);
  url.searchParams.set("X-Amz-Expires", String(ttlSeconds));
  const request = await client.sign(url.toString(), {
    method,
    ...(contentType ? { headers: { "content-type": contentType } } : {}),
    aws: { signQuery: true },
  });
  return request.url;
}
function sameExecution(row: UploadSessionRow, principal: Principal): boolean {
  const executionActor = actor(principal);
  return row.application_id === principal.clientId
    && row.principal_type === principal.type
    && row.principal_id === principal.id
    && row.actor_type === executionActor.type
    && row.actor_id === executionActor.id;
}

async function resolveTarget(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  modelKey: string,
  fieldKey: string,
  recordId: string | null,
  selectedDelegation: string | null,
): Promise<ResolvedTarget> {
  if (await isExternalModelAddress(env, modelKey)) {
    if (!recordId) throw new ApiError("VALIDATION_ERROR", "External file upload requires recordId", 422);
    const model = await getExternalModel(env, spaceId, modelKey);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
    const field = model.snapshot.fields.find((candidate) => candidate.key === fieldKey);
    if (field?.type !== "file_ref_list" || field.upload?.supported !== true) {
      throw new ApiError("FILE_UPLOAD_UNSUPPORTED", "Field does not support file upload", 405);
    }
    const decision = await requireModelAccess(env, principal, spaceId, externalAuthorityModel(model), "write", {
      delegationId: selectedDelegation,
      recordId,
    });
    if (decision.authority.singleUse) throw new ApiError("FILE_UPLOAD_SINGLE_USE_UNSUPPORTED", "Multi-step upload cannot use a single-use Delegation", 422);
    return { destination: "external", maxBytes: field.upload.maxBytes, decision, externalModel: model };
  }

  const model = await getRuntimeModel(env, modelKey);
  if (!model || model.definition.origin === "external") throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
  if (fieldKey === RECORD_ICON_FIELD) {
    if (!recordId) throw new ApiError("VALIDATION_ERROR", "Record Icon upload requires recordId", 422);
    const decision = await requireModelAccess(env, principal, spaceId, model, "write", {
      delegationId: selectedDelegation, recordId,
    });
    if (decision.authority.singleUse) throw new ApiError("FILE_UPLOAD_SINGLE_USE_UNSUPPORTED", "Multi-step Icon upload cannot use a single-use Delegation", 422);
    const record = await getGenericResource(env, spaceId, model, recordId);
    if (!record) throw new ApiError("RESOURCE_NOT_FOUND", "Record not found", 404);
    await requireModelPolicy(env, decision.principal, spaceId, model, "update", record, {}, decision.policyIdentity);
    return { destination: "native", maxBytes: ICON_MAX_BYTES, decision, nativeModel: model };
  }
  const field = model.definition.fields[fieldKey];
  if (!field || field.readOnly === true || (field.type !== "file" && field.type !== "file_list")) {
    throw new ApiError("FILE_UPLOAD_UNSUPPORTED", "Field does not accept LifeSpace Files", 405);
  }
  const decision = await requireModelAccess(env, principal, spaceId, model, "write", {
    delegationId: selectedDelegation,
    ...(recordId ? { recordId } : {}),
  });
  if (decision.authority.singleUse) throw new ApiError("FILE_UPLOAD_SINGLE_USE_UNSUPPORTED", "Multi-step upload cannot use a single-use Delegation", 422);
  return { destination: "native", maxBytes: NATIVE_MAX_BYTES, decision, nativeModel: model };
}

async function loadSession(env: Bindings, spaceId: string, uploadId: string): Promise<UploadSessionRow> {
  if (!/^upl_[a-f0-9]{32}$/u.test(uploadId)) throw new ApiError("UPLOAD_NOT_FOUND", "Upload not found", 404);
  const row = await env.DB.prepare("SELECT * FROM file_upload_sessions WHERE id=? AND space_id=?").bind(uploadId, spaceId).first<UploadSessionRow>();
  if (!row) throw new ApiError("UPLOAD_NOT_FOUND", "Upload not found", 404);
  return row;
}

async function createSession(context: Context<AppEnv>) {
  const input = object(await context.req.json<unknown>().catch(() => null));
  onlyKeys(input, ["modelKey", "fieldKey", "recordId", "name", "contentType", "size"]);
  const modelKey = bounded(input.modelKey, "modelKey", 63);
  const fieldKey = bounded(input.fieldKey, "fieldKey", 63);
  const recordId = input.recordId === undefined || input.recordId === null ? null : bounded(input.recordId, "recordId", 256);
  const name = bounded(input.name, "name", 512);
  const contentType = bounded(input.contentType, "contentType", 255).toLowerCase();
  if (!Number.isInteger(input.size) || Number(input.size) < 1) throw new ApiError("VALIDATION_ERROR", "size must be a positive integer", 422);
  const size = Number(input.size);
  if (fieldKey === RECORD_ICON_FIELD && !["image/png", "image/jpeg", "image/webp"].includes(contentType)) {
    throw new ApiError("INVALID_ICON_IMAGE", "Icon uploads support static PNG, JPEG or WebP only", 415);
  }
  const spaceId = context.req.param("spaceId")!;
  const target = await resolveTarget(context.env, context.get("principal"), spaceId, modelKey, fieldKey, recordId, delegationId(context));
  if (size > target.maxBytes) throw new ApiError("FILE_TOO_LARGE", `File exceeds the field upload limit of ${target.maxBytes} bytes`, 413);
  const execution = target.decision.principal;
  const executionActor = actor(execution);
  const uploadId = `upl_${crypto.randomUUID().replaceAll("-", "")}`;
  const fileId = target.destination === "native" ? `fil_${crypto.randomUUID().replaceAll("-", "")}` : null;
  const objectKey = target.destination === "native" ? `uploads/native/${spaceId}/${uploadId}` : `uploads/external/${spaceId}/${uploadId}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString();
  const uploadUrl = await presignR2Object(context.env, objectKey, "PUT", UPLOAD_TTL_SECONDS, contentType);
  await context.env.DB.prepare(`INSERT INTO file_upload_sessions(
    id,space_id,model_key,field_key,record_id,destination,file_id,object_key,name,content_type,expected_size,status,
    application_id,principal_type,principal_id,actor_type,actor_id,expires_at,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)`).bind(
    uploadId, spaceId, modelKey, fieldKey, recordId, target.destination, fileId, objectKey, name, contentType, size,
    execution.clientId, execution.type, execution.id, executionActor.type, executionActor.id, expiresAt, now.toISOString(),
  ).run();
  return context.json(success({
    id: uploadId,
    destination: target.destination,
    upload: { method: "PUT", url: uploadUrl, headers: { "content-type": contentType }, expiresAt },
  }), 201);
}

async function verifyUploadedObject(env: Bindings, row: UploadSessionRow): Promise<R2Object> {
  const object = await env.ASSETS.head(row.object_key);
  if (!object) throw new ApiError("UPLOAD_INCOMPLETE", "Uploaded object is not available", 409);
  if (object.size !== row.expected_size) throw new ApiError("UPLOAD_MISMATCH", "Uploaded object size does not match the declared file", 409);
  const actualType = object.httpMetadata?.contentType?.toLowerCase();
  if (!actualType || actualType !== row.content_type) throw new ApiError("UPLOAD_MISMATCH", "Uploaded object content type does not match the declared file", 409);
  return object;
}

async function acquireExecution(env: Bindings, row: UploadSessionRow): Promise<void> {
  const result = await env.DB.prepare("UPDATE file_upload_sessions SET status='executing' WHERE id=? AND status='pending'").bind(row.id).run();
  if (!result.meta.changes) throw new ApiError("UPLOAD_STATE_CONFLICT", "Upload session is no longer pending", 409);
}

async function completeSession(context: Context<AppEnv>) {
  const spaceId = context.req.param("spaceId")!;
  const row = await loadSession(context.env, spaceId, context.req.param("uploadId")!);
  if (row.status !== "pending") {
    if (row.status === "unknown" || row.status === "executing") throw new ApiError("EXTERNAL_WRITE_UNKNOWN", "Upload outcome is unknown and must not be retried blindly", 502);
    throw new ApiError("UPLOAD_STATE_CONFLICT", `Upload session is ${row.status}`, 409);
  }
  if (Date.parse(row.expires_at) <= Date.now()) {
    await context.env.DB.prepare("UPDATE file_upload_sessions SET status='expired' WHERE id=? AND status='pending'").bind(row.id).run();
    await context.env.ASSETS.delete(row.object_key).catch(() => undefined);
    throw new ApiError("UPLOAD_EXPIRED", "Upload session expired", 409);
  }
  const target = await resolveTarget(context.env, context.get("principal"), spaceId, row.model_key, row.field_key, row.record_id, delegationId(context));
  if (target.destination !== row.destination || !sameExecution(row, target.decision.principal)) throw new ApiError("UPLOAD_AUTHORITY_CHANGED", "Upload execution authority no longer matches the session", 403);
  await verifyUploadedObject(context.env, row);
  await acquireExecution(context.env, row);
  const completedAt = new Date().toISOString();

  if (row.destination === "native") {
    try {
      if (!row.file_id || !/^fil_[a-f0-9]{32}$/u.test(row.file_id)) throw new ApiError("UPLOAD_STATE_INVALID", "Native upload is missing its File identity", 500);
      // The signed PUT URL must never address a durable File object. Otherwise a client
      // could overwrite a completed file until the upload signature expires.
      const permanentKey = `files/${spaceId}/${row.file_id}`;
      const staged = await context.env.ASSETS.get(row.object_key);
      if (!staged || staged.size !== row.expected_size || staged.httpMetadata?.contentType?.toLowerCase() !== row.content_type) {
        throw new ApiError("UPLOAD_MISMATCH", "Staged file does not match upload session", 409);
      }
      try {
        // Validate real object bytes and dimensions before promoting the Icon File.
        // The size check during upload initiation is not a security boundary.
        const imageBytes = row.field_key === RECORD_ICON_FIELD
          ? new Uint8Array(await staged.arrayBuffer())
          : null;
        if (imageBytes) validateRecordIconImage(imageBytes, row.content_type);
        await context.env.ASSETS.put(permanentKey, imageBytes ?? staged.body, { httpMetadata: { contentType: row.content_type } });
        const promoted = await context.env.ASSETS.head(permanentKey);
        if (!promoted || promoted.size !== row.expected_size || promoted.httpMetadata?.contentType?.toLowerCase() !== row.content_type) {
          throw new ApiError("FILE_FINALIZE_FAILED", "Promoted file verification failed", 502);
        }
        const execution = target.decision.principal;
        const executionActor = actor(execution);
        await context.env.DB.batch([
          context.env.DB.prepare(`INSERT INTO files(
            id,space_id,name,content_type,size_bytes,object_key,status,application_id,principal_type,principal_id,actor_type,actor_id,created_at
          ) VALUES(?,?,?,?,?,?,'ready',?,?,?,?,?,?)`).bind(
            row.file_id, spaceId, row.name, row.content_type, row.expected_size, permanentKey,
            execution.clientId, execution.type, execution.id, executionActor.type, executionActor.id, completedAt,
          ),
          context.env.DB.prepare("UPDATE file_upload_sessions SET status='completed',completed_at=? WHERE id=? AND status='executing'").bind(completedAt, row.id),
        ]);
      } catch (error) {
        // D1 may have committed before a transport error. Do not destroy a
        // permanent object that a ready File row might already reference.
        let safeToDelete = false;
        try {
          const published = await context.env.DB.prepare("SELECT id FROM files WHERE id=? AND space_id=?")
            .bind(row.file_id, spaceId).first<{ id: string }>();
          safeToDelete = !published;
        } catch { /* preserve bytes when publication outcome cannot be determined */ }
        if (safeToDelete) await context.env.ASSETS.delete(permanentKey).catch(() => undefined);
        throw error;
      }
      try {
        await context.env.ASSETS.delete(row.object_key);
        await context.env.DB.prepare("UPDATE file_upload_sessions SET cleaned_at=? WHERE id=? AND status='completed'")
          .bind(new Date().toISOString(), row.id).run();
      } catch { /* scheduled cleanup removes a completed session's staging object */ }
      return context.json(success({
        id: row.file_id,
        name: row.name,
        contentType: row.content_type,
        size: row.expected_size,
        createdAt: completedAt,
      }));
    } catch (error) {
      await context.env.DB.prepare("UPDATE file_upload_sessions SET status='failed',error_code=? WHERE id=? AND status='executing'")
        .bind(error instanceof ApiError ? error.code : "FILE_FINALIZE_FAILED", row.id).run().catch(() => undefined);
      throw error;
    }
  }

  try {
    const sourceUrl = await presignR2Object(context.env, row.object_key, "GET", DOWNLOAD_TTL_SECONDS);
    const result = await executeExternalOperation(
      context.env,
      target.externalModel!,
      target.decision,
      "upload",
      { fieldKey: row.field_key, sourceUrl, name: row.name, contentType: row.content_type, size: row.expected_size },
      row.record_id!,
    );
    const finalized = await context.env.DB.prepare("UPDATE file_upload_sessions SET status='completed',completed_at=? WHERE id=? AND status='executing'")
      .bind(completedAt, row.id).run();
    if (!finalized.meta.changes) throw new ExternalError("EXTERNAL_WRITE_UNKNOWN", 502);
    try {
      await context.env.ASSETS.delete(row.object_key);
      await context.env.DB.prepare("UPDATE file_upload_sessions SET cleaned_at=? WHERE id=?").bind(new Date().toISOString(), row.id).run();
    } catch {
      // Provider is already authoritative. Cleanup cannot change a successful upload into a retryable write failure.
    }
    return context.json(success(result));
  } catch (error) {
    const unknown = error instanceof ExternalError && error.code === "EXTERNAL_WRITE_UNKNOWN";
    await context.env.DB.prepare("UPDATE file_upload_sessions SET status=?,error_code=? WHERE id=? AND status='executing'")
      .bind(unknown ? "unknown" : "failed", error instanceof ApiError ? error.code : "EXTERNAL_WRITE_UNKNOWN", row.id).run().catch(() => undefined);
    if (!unknown) {
      try {
        await context.env.ASSETS.delete(row.object_key);
        await context.env.DB.prepare("UPDATE file_upload_sessions SET cleaned_at=? WHERE id=?").bind(new Date().toISOString(), row.id).run();
      } catch { /* bounded scheduled cleanup will retry */ }
    }
    throw error;
  }
}

/** File download is a Record read projection, not a second route around Model Policy.
 * V1 read Policy is identity-only, so the pre-resolved Policy identity avoids
 * additional D1 lookups. The File link must still be validated separately.
 */
export async function requireNativeFileReadPolicy(
  env: Bindings,
  decision: ModelAccessDecision,
  spaceId: string,
  model: PublishedModel,
): Promise<void> {
  if (!model.definition.policies?.read) return;
  await requireModelPolicy(env, decision.principal, spaceId, model, "read", undefined, undefined, decision.policyIdentity);
}

async function createDownload(context: Context<AppEnv>) {
  const input = object(await context.req.json<unknown>().catch(() => null));
  onlyKeys(input, ["modelKey", "recordId", "fieldKey", "fileId"]);
  const modelKey = bounded(input.modelKey, "modelKey", 63);
  const recordId = bounded(input.recordId, "recordId", 256);
  const fieldKey = bounded(input.fieldKey, "fieldKey", 63);
  const fileId = bounded(input.fileId, "fileId", 36);
  if (!/^fil_[a-f0-9]{32}$/u.test(fileId)) throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  const spaceId = context.req.param("spaceId")!;
  const model = await getRuntimeModel(context.env, modelKey);
  if (!model || model.definition.origin === "external") throw new ApiError("MODEL_NOT_FOUND", "Model not found", 404);
  const field = model.definition.fields[fieldKey];
  if (fieldKey !== RECORD_ICON_FIELD && (!field || (field.type !== "file" && field.type !== "file_list"))) throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  const decision = await requireModelAccess(context.env, context.get("principal"), spaceId, model, "read", { delegationId: delegationId(context), recordId });
  await requireNativeFileReadPolicy(context.env, decision, spaceId, model);
  if (fieldKey === RECORD_ICON_FIELD) {
    const current = await context.env.DB.prepare(`SELECT icon_json FROM resource_records
      WHERE id=? AND space_id=? AND model_key=? AND deleted_at IS NULL`)
      .bind(recordId, spaceId, modelKey).first<{ icon_json: string | null }>();
    const icon = current?.icon_json ? JSON.parse(current.icon_json) as { type?: string; fileId?: string } : null;
    if (icon?.type !== "image" || icon.fileId !== fileId) throw new ApiError("FILE_NOT_FOUND", "Icon reference not found", 404);
  }
  const row = await context.env.DB.prepare(`SELECT f.id,f.name,f.content_type,f.size_bytes,f.object_key,f.created_at
    FROM resource_file_links l JOIN files f ON f.id=l.file_id
    WHERE l.source_space_id=? AND l.source_model_key=? AND l.source_record_id=? AND l.field_key=? AND l.file_id=? AND f.status='ready'`)
    .bind(spaceId, modelKey, recordId, fieldKey, fileId).first<{ id: string; name: string; content_type: string; size_bytes: number; object_key: string; created_at: string }>();
  if (!row) throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  const url = await presignR2Object(context.env, row.object_key, "GET", DOWNLOAD_TTL_SECONDS);
  const expiresAt = new Date(Date.now() + DOWNLOAD_TTL_SECONDS * 1000).toISOString();
  await consumeSingleUseRead(context.env, decision);
  return context.json(success({ id: row.id, name: row.name, contentType: row.content_type, size: row.size_bytes, createdAt: row.created_at, url, expiresAt }));
}

async function deleteNativeFile(context: Context<AppEnv>) {
  const spaceId = context.req.param("spaceId")!;
  const fileId = context.req.param("fileId")!;
  if (!/^fil_[a-f0-9]{32}$/u.test(fileId)) throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  const session = await context.env.DB.prepare(`SELECT * FROM file_upload_sessions
    WHERE space_id=? AND file_id=? AND destination='native' AND status='completed'
    LIMIT 1`).bind(spaceId, fileId).first<UploadSessionRow>();
  if (!session) throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  // The File belongs to the original Space/model field. Reuse current Model
  // Authority rather than inventing a separate File ACL or trusting uploader metadata.
  const target = await resolveTarget(
    context.env, context.get("principal"), spaceId, session.model_key, session.field_key,
    session.record_id, delegationId(context),
  );
  if (target.destination !== "native") throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  const file = await context.env.DB.prepare("SELECT id,object_key,status FROM files WHERE space_id=? AND id=?")
    .bind(spaceId, fileId).first<{ id: string; object_key: string; status: string }>();
  if (!file) throw new ApiError("FILE_NOT_FOUND", "File not found", 404);
  if (file.status === "deleted") return context.body(null, 204);
  if (file.status === "ready") {
    const principal = target.decision.principal;
    const acting = actor(principal);
    // Atomic guard: once status becomes deleting, the insert trigger blocks
    // concurrent attempts to attach this File to a Record.
    const marked = await context.env.DB.prepare(`UPDATE files SET status='deleting',
      deletion_requested_at=?,deleted_by_principal_type=?,deleted_by_principal_id=?,
      deleted_by_actor_type=?,deleted_by_actor_id=?
      WHERE id=? AND space_id=? AND status='ready'
      AND NOT EXISTS(SELECT 1 FROM resource_file_links WHERE file_id=?)`).bind(
      new Date().toISOString(), principal.type, principal.id, acting.type, acting.id,
      fileId, spaceId, fileId,
    ).run();
    if (!marked.meta.changes) throw new ApiError("FILE_IN_USE", "Detach File from all Records before deletion", 409);
  } else if (file.status !== "deleting") {
    throw new ApiError("FILE_STATE_INVALID", "File cannot be deleted in its current state", 409);
  }
  try {
    await context.env.ASSETS.delete(file.object_key);
  } catch {
    // Keep 'deleting' so the scheduled cleanup can finish safely.
    throw new ApiError("FILE_STORAGE_UNAVAILABLE", "File deletion will be retried", 503);
  }
  await context.env.DB.prepare("UPDATE files SET status='deleted',deleted_at=? WHERE id=? AND space_id=? AND status='deleting'")
    .bind(new Date().toISOString(), fileId, spaceId).run();
  return context.body(null, 204);
}

export async function cleanupFileUploads(env: Bindings): Promise<void> {
  const now = new Date().toISOString();
  // Preserve ambiguous External writes for reconciliation, but not their staged
  // bytes indefinitely. Completed Native files are safe: object_key is staging,
  // and the permanent key lives only in the ready File row.
  const staleExecuting = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const staleUnknown = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await env.DB.prepare(`SELECT * FROM file_upload_sessions
    WHERE cleaned_at IS NULL AND (
      (status='pending' AND expires_at<=?)
      OR status='failed'
      OR status='completed'
      OR (status='executing' AND expires_at<=?)
      OR (status='unknown' AND expires_at<=?)
    ) ORDER BY created_at LIMIT 50`).bind(now, staleExecuting, staleUnknown).all<UploadSessionRow>();
  for (const row of rows.results ?? []) {
    try {
      if (row.destination === "native" && row.file_id && (row.status === "failed" || row.status === "executing")) {
        const published = await env.DB.prepare("SELECT id FROM files WHERE id=? AND space_id=?")
          .bind(row.file_id, row.space_id).first<{ id: string }>();
        // A failed promotion can leave an unreferenced permanent object if
        // deletion also failed; never delete a published File's bytes.
        if (!published) await env.ASSETS.delete(`files/${row.space_id}/${row.file_id}`);
      }
      await env.ASSETS.delete(row.object_key);
      await env.DB.prepare(`UPDATE file_upload_sessions
        SET cleaned_at=?,
            status=CASE WHEN status='pending' THEN 'expired' WHEN status='executing' THEN 'unknown' ELSE status END,
            error_code=CASE WHEN status='executing' THEN 'FILE_UPLOAD_RECONCILIATION_REQUIRED' ELSE error_code END
        WHERE id=? AND cleaned_at IS NULL`).bind(now, row.id).run();
    } catch (error) {
      console.error("File upload cleanup failed", { uploadId: row.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  // Reconcile deletions that were committed in D1 but interrupted before
  // the R2 object was removed or the terminal tombstone was persisted.
  const deletions = await env.DB.prepare("SELECT id,object_key FROM files WHERE status='deleting' ORDER BY deletion_requested_at LIMIT 20")
    .all<{ id: string; object_key: string }>();
  for (const file of deletions.results ?? []) {
    try {
      await env.ASSETS.delete(file.object_key);
      await env.DB.prepare("UPDATE files SET status='deleted',deleted_at=? WHERE id=? AND status='deleting'")
        .bind(new Date().toISOString(), file.id).run();
    } catch {
      // Keep the tombstone transition pending until the next scheduled sweep.
    }
  }
}

export function registerFileRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/file-uploads", createSession);
  app.post("/api/v1/spaces/:spaceId/file-uploads/:uploadId/complete", completeSession);
  app.post("/api/v1/spaces/:spaceId/file-downloads", createDownload);
  app.delete("/api/v1/spaces/:spaceId/files/:fileId", deleteNativeFile);
}

import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import {
  CREATION_KINDS,
  CreationDraftInvalidResponseError,
  normalizeCreationDraftOutput,
  type ActivePersonRef,
  type CreationKind,
} from "./creation-draft-model";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { createOpenAICompatibleProvider, OpenAICompatibleProviderError } from "./openai-compatible-provider";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;

export type CreationDraftQueueMessage = { draftId: string; generation: number };

type JobRow = {
  id: string;
  space_id: string;
  requested_by_user_id: string;
  status: "queued" | "processing" | "choose_kind" | "ready" | "failed";
  generation: number;
  input_text: string | null;
  viewing_timezone: string;
  target_kind: CreationKind | null;
  result_json: string | null;
  error_code: string | null;
  attempt_count: number;
  expires_at: string;
};

type SpaceContext = {
  timezone: string;
  people: ActivePersonRef[];
  requestingPersonRef: string;
};

export type CreationDraftDependencies = {
  now: () => Date;
  createProvider: (env: Bindings) => ReturnType<typeof createOpenAICompatibleProvider>;
};

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export function defaultCreationProvider(env: Bindings) {
  return createOpenAICompatibleProvider({
    baseUrl: env.AI_BASE_URL ?? "",
    apiKey: env.AI_API_KEY ?? "",
    model: env.AI_MODEL ?? "",
    promptAppendix: env.AI_PROMPT_APPENDIX,
    appTitle: "LifeSpace",
    appReferer: "https://core.aisr.online",
    requireParameters: true,
  });
}

function requireUser(principal: Principal): asserts principal is Principal & { type: "user" } {
  if (principal.type !== "user") throw new ApiError("FORBIDDEN", "Creation drafts require an active user Space member", 403);
}

async function body(context: Context<AppEnv>): Promise<Body> {
  try {
    const value = await context.req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Body;
  } catch {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON object", 400);
  }
}

function timezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError("VALIDATION_ERROR", "viewingTimezone must be an IANA timezone", 422);
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date(0)); }
  catch { throw new ApiError("VALIDATION_ERROR", "viewingTimezone must be an IANA timezone", 422); }
  return value;
}

function parseCreateInput(input: Body): { text: string; viewingTimezone: string } {
  if (Object.keys(input).some((field) => !["text", "viewingTimezone"].includes(field))) throw new ApiError("INVALID_REQUEST", "Request contains unsupported creation draft fields", 400);
  if (typeof input.text !== "string" || input.text.trim().length < 1 || input.text.trim().length > 5000) throw new ApiError("VALIDATION_ERROR", "text must contain 1-5000 characters", 422);
  return { text: input.text.trim(), viewingTimezone: timezone(input.viewingTimezone) };
}

function parseKindInput(input: Body): CreationKind {
  if (Object.keys(input).some((field) => field !== "targetKind") || !CREATION_KINDS.includes(input.targetKind as CreationKind)) {
    throw new ApiError("VALIDATION_ERROR", "targetKind is invalid", 422);
  }
  return input.targetKind as CreationKind;
}

function spaceToday(zone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

async function spaceContext(env: Bindings, spaceId: string, userId: string): Promise<SpaceContext> {
  const space = await env.DB.prepare("SELECT timezone FROM spaces WHERE id=? AND deleted_at IS NULL").bind(spaceId).first<{ timezone: string }>();
  if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);
  const membership = await env.DB.prepare("SELECT id FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL")
    .bind(spaceId, userId).first();
  if (!membership) throw new ApiError("FORBIDDEN", "Creation drafts require an active Space membership", 403);
  const rows = await env.DB.prepare(`SELECT id,linked_user_id,display_name
    FROM space_people WHERE space_id=? AND deleted_at IS NULL
    ORDER BY created_at,id`).bind(spaceId).all<{ id: string; linked_user_id: string | null; display_name: string }>();
  const people = rows.results.map((person, index) => ({ ref: `p${index + 1}`, personId: person.id, name: person.display_name, linkedUserId: person.linked_user_id }));
  const requester = people.find((person) => person.linkedUserId === userId);
  if (!requester) throw new ApiError("FORBIDDEN", "Requesting user has no active Space Person", 403);
  return {
    timezone: space.timezone,
    people: people.map(({ ref, personId, name }) => ({ ref, personId, name })),
    requestingPersonRef: requester.ref,
  };
}

async function ownedJob(env: Bindings, spaceId: string, draftId: string, userId: string): Promise<JobRow> {
  const job = await env.DB.prepare(`SELECT * FROM creation_draft_jobs
    WHERE id=? AND space_id=? AND requested_by_user_id=?`).bind(draftId, spaceId, userId).first<JobRow>();
  if (!job) throw new ApiError("CREATION_DRAFT_NOT_FOUND", "Creation draft job not found", 404);
  if (Date.parse(job.expires_at) <= Date.now()) throw new ApiError("CREATION_DRAFT_EXPIRED", "Creation draft job expired", 404);
  return job;
}

function serializeJob(job: JobRow) {
  const status = job.status === "queued" ? "processing" : job.status;
  const base = { draftId: job.id, status, expiresAt: job.expires_at };
  if (job.status === "choose_kind" || job.status === "ready") return { ...base, ...(job.result_json ? JSON.parse(job.result_json) : {}) };
  if (job.status === "failed") return { ...base, error: { code: job.error_code ?? "AI_PROVIDER_UNAVAILABLE" } };
  return base;
}

async function enqueue(env: Bindings, message: CreationDraftQueueMessage): Promise<void> {
  try { await env.CREATION_DRAFT_QUEUE.send(message); }
  catch {
    await env.DB.prepare(`UPDATE creation_draft_jobs SET status='failed',error_code='AI_QUEUE_UNAVAILABLE',input_text=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND generation=?`)
      .bind(message.draftId, message.generation).run();
    throw new ApiError("AI_QUEUE_UNAVAILABLE", "AI creation queue is unavailable", 502);
  }
}

function providerErrorCode(error: unknown): string {
  if (error instanceof OpenAICompatibleProviderError) {
    const map: Record<string, string> = {
      AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
      AI_TIMEOUT: "AI_PROVIDER_TIMEOUT",
      AI_RATE_LIMITED: "AI_RATE_LIMITED",
      AI_AUTHENTICATION_FAILED: "AI_AUTHENTICATION_FAILED",
      AI_QUOTA_EXCEEDED: "AI_QUOTA_EXCEEDED",
      AI_ACCESS_DENIED: "AI_ACCESS_DENIED",
      AI_MODEL_NOT_FOUND: "AI_MODEL_NOT_FOUND",
      AI_REQUEST_REJECTED: "AI_REQUEST_REJECTED",
      AI_INVALID_RESPONSE: "AI_INVALID_RESPONSE",
    };
    return map[error.code] ?? "AI_PROVIDER_UNAVAILABLE";
  }
  if (error instanceof CreationDraftInvalidResponseError) return "AI_INVALID_RESPONSE";
  return "AI_PROVIDER_UNAVAILABLE";
}

export function registerCreationDraftRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/creation-drafts", requireScope("creation-drafts:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "read");
    await spaceContext(c.env, spaceId, principal.id);
    const input = parseCreateInput(await body(c));
    const rate = await c.env.AI_RATE_LIMITER.limit({ key: principal.id });
    if (!rate.success) throw new ApiError("AI_RATE_LIMITED", "AI creation rate limit reached", 429);
    const draftId = createId("drf");
    const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
    await c.env.DB.prepare(`INSERT INTO creation_draft_jobs
      (id,space_id,requested_by_user_id,status,generation,input_text,viewing_timezone,expires_at)
      VALUES(?,?,?,'queued',1,?,?,?)`).bind(draftId, spaceId, principal.id, input.text, input.viewingTimezone, expiresAt).run();
    await enqueue(c.env, { draftId, generation: 1 });
    return c.json(success({ draftId, status: "processing", expiresAt }), 202);
  });

  app.get("/api/v1/spaces/:spaceId/creation-drafts/:draftId", requireScope("creation-drafts:read"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "read");
    const job = await ownedJob(c.env, spaceId, c.req.param("draftId"), principal.id);
    return c.json(success(serializeJob(job)));
  });

  app.post("/api/v1/spaces/:spaceId/creation-drafts/:draftId/choose-kind", requireScope("creation-drafts:write"), async (c) => {
    const principal = c.get("principal");
    requireUser(principal);
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, principal, spaceId, "read");
    await spaceContext(c.env, spaceId, principal.id);
    const draftId = c.req.param("draftId");
    const job = await ownedJob(c.env, spaceId, draftId, principal.id);
    if (job.status !== "choose_kind") throw new ApiError("CREATION_DRAFT_STATE_CONFLICT", "Creation draft is not awaiting a kind", 409);
    const targetKind = parseKindInput(await body(c));
    const generation = job.generation + 1;
    const result = await c.env.DB.prepare(`UPDATE creation_draft_jobs SET status='queued',generation=?,target_kind=?,result_json=NULL,error_code=NULL,
      started_at=NULL,completed_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND generation=? AND status='choose_kind'`)
      .bind(generation, targetKind, draftId, job.generation).run();
    if (!result.meta.changes) throw new ApiError("CREATION_DRAFT_STATE_CONFLICT", "Creation draft changed", 409);
    await enqueue(c.env, { draftId, generation });
    return c.json(success({ draftId, status: "processing", expiresAt: job.expires_at }), 202);
  });
}

async function processOne(env: Bindings, dependencies: CreationDraftDependencies, message: CreationDraftQueueMessage): Promise<void> {
  const claim = await env.DB.prepare(`UPDATE creation_draft_jobs SET status='processing',attempt_count=attempt_count+1,
    started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND generation=? AND status='queued' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(message.draftId, message.generation).run();
  if (!claim.meta.changes) return;
  const job = await env.DB.prepare("SELECT * FROM creation_draft_jobs WHERE id=? AND generation=?")
    .bind(message.draftId, message.generation).first<JobRow>();
  if (!job || !job.input_text) return;

  try {
    const startedAt = dependencies.now();
    const context = await spaceContext(env, job.space_id, job.requested_by_user_id);
    const provider = dependencies.createProvider(env);
    const providerResult = await provider.generate({
      text: job.input_text,
      currentInstant: startedAt.toISOString(),
      spaceTimezone: context.timezone,
      viewingTimezone: job.viewing_timezone,
      supportedKinds: CREATION_KINDS,
      people: context.people.map(({ ref, name }) => ({ ref, name })),
      requestingPersonRef: context.requestingPersonRef,
      ...(job.target_kind ? { targetKind: job.target_kind } : {}),
    });
    const normalized = normalizeCreationDraftOutput(providerResult.output, {
      people: context.people,
      spaceToday: spaceToday(context.timezone, startedAt),
      supportedKinds: CREATION_KINDS,
      ...(job.target_kind ? { targetKind: job.target_kind } : {}),
    });
    const finalStatus = normalized.status === "choose_kind" ? "choose_kind" : "ready";
    await env.DB.prepare(`UPDATE creation_draft_jobs SET status=?,result_json=?,error_code=NULL,
      input_text=CASE WHEN ?='ready' THEN NULL ELSE input_text END,
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND generation=? AND status='processing'`)
      .bind(finalStatus, JSON.stringify(normalized), finalStatus, job.id, job.generation).run();
    console.info("AI creation draft processed", {
      draftId: job.id,
      status: finalStatus,
      providerStatus: providerResult.metadata.providerStatus,
      totalTokens: providerResult.metadata.usage?.totalTokens,
    });
  } catch (error) {
    const code = providerErrorCode(error);
    await env.DB.prepare(`UPDATE creation_draft_jobs SET status='failed',result_json=NULL,error_code=?,input_text=NULL,
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND generation=? AND status='processing'`).bind(code, job.id, job.generation).run();
    console.warn("AI creation draft failed", { draftId: job.id, errorCategory: code });
  }
}

export async function processCreationDraftQueue(
  batch: MessageBatch<CreationDraftQueueMessage>, env: Bindings, dependencies: CreationDraftDependencies,
): Promise<void> {
  for (const message of batch.messages) {
    try { await processOne(env, dependencies, message.body); message.ack(); }
    catch (error) {
      console.error("Creation draft queue message failed", { draftId: message.body.draftId, generation: message.body.generation, error });
      message.retry();
    }
  }
}

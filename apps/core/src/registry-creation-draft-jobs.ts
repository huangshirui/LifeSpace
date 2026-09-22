import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { getOrCreateActiveModelContract } from "./model-contract-service";
import {
  buildRegistryCreationDraftSchema,
  creationDraftModelDescriptors,
  listWritableCreationModels,
  normalizeRegistryCreationDraft,
  type RegistryPersonRef,
} from "./registry-creation-draft";
import { createRegistryOpenAIProvider, OpenAICompatibleProviderError } from "./registry-openai-provider";
import { assertIanaTimezone } from "./time-semantics";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
export type RegistryCreationDraftQueueMessage = { draftId: string; generation: number };

type JobRow = {
  id: string;
  space_id: string;
  requested_by_user_id: string;
  requesting_client_id: string;
  model_contract_revision: string;
  status: "queued" | "processing" | "choose_model" | "ready" | "failed";
  generation: number;
  input_text: string | null;
  viewing_timezone: string;
  target_model_key: string | null;
  result_json: string | null;
  error_code: string | null;
  attempt_count: number;
  expires_at: string;
};

type SpaceContext = {
  timezone: string;
  people: RegistryPersonRef[];
  requestingPersonRef: string;
};

export type RegistryCreationDraftDependencies = {
  now: () => Date;
  createProvider: (env: Bindings) => ReturnType<typeof createRegistryOpenAIProvider>;
};

const JOB_TTL_MS = 24 * 60 * 60 * 1000;
const createId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export function defaultRegistryCreationProvider(env: Bindings) {
  return createRegistryOpenAIProvider({
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
  if (principal.type !== "user") {
    throw new ApiError("FORBIDDEN", "Creation drafts require an active user Space member", 403);
  }
}

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be valid JSON object", 400);
  }
  return value as Body;
}

function timezone(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("VALIDATION_ERROR", "viewingTimezone must be an IANA timezone", 422);
  }
  try {
    return assertIanaTimezone(value);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "viewingTimezone must be an IANA timezone", 422);
  }
}

function createInput(input: Body) {
  if (Object.keys(input).some((field) => !["text", "viewingTimezone"].includes(field))) {
    throw new ApiError("INVALID_REQUEST", "Request contains unsupported creation draft fields", 400);
  }
  if (
    typeof input.text !== "string"
    || input.text.trim().length < 1
    || input.text.trim().length > 5000
  ) {
    throw new ApiError("VALIDATION_ERROR", "text must contain 1-5000 characters", 422);
  }
  return { text: input.text.trim(), viewingTimezone: timezone(input.viewingTimezone) };
}

function modelInput(input: Body): string {
  if (
    Object.keys(input).some((field) => field !== "targetModelKey")
    || typeof input.targetModelKey !== "string"
    || !input.targetModelKey
  ) {
    throw new ApiError("VALIDATION_ERROR", "targetModelKey is required", 422);
  }
  return input.targetModelKey;
}

async function spaceContext(env: Bindings, spaceId: string, userId: string): Promise<SpaceContext> {
  const space = await env.DB.prepare(
    "SELECT timezone FROM spaces WHERE id=? AND deleted_at IS NULL",
  ).bind(spaceId).first<{ timezone: string }>();
  if (!space) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

  const membership = await env.DB.prepare(
    "SELECT id FROM space_memberships WHERE space_id=? AND user_id=? AND deleted_at IS NULL",
  ).bind(spaceId, userId).first();
  if (!membership) {
    throw new ApiError("FORBIDDEN", "Creation drafts require an active Space membership", 403);
  }

  const rows = await env.DB.prepare(
    "SELECT id,linked_user_id,display_name FROM space_people WHERE space_id=? AND deleted_at IS NULL ORDER BY created_at,id",
  ).bind(spaceId).all<{ id: string; linked_user_id: string | null; display_name: string }>();
  const people = rows.results.map((person, index) => ({
    ref: `p${index + 1}`,
    personId: person.id,
    name: person.display_name,
    linkedUserId: person.linked_user_id,
  }));
  const requester = people.find((person) => person.linkedUserId === userId);
  if (!requester) {
    throw new ApiError("FORBIDDEN", "Requesting user has no active Space Person", 403);
  }
  return {
    timezone: space.timezone,
    people: people.map(({ ref, personId, name }) => ({ ref, personId, name })),
    requestingPersonRef: requester.ref,
  };
}

async function ownedJob(env: Bindings, spaceId: string, draftId: string, userId: string): Promise<JobRow> {
  const job = await env.DB.prepare(
    "SELECT * FROM creation_draft_jobs WHERE id=? AND space_id=? AND requested_by_user_id=?",
  ).bind(draftId, spaceId, userId).first<JobRow>();
  if (!job || Date.parse(job.expires_at) <= Date.now()) {
    throw new ApiError("CREATION_DRAFT_NOT_FOUND", "Creation draft job not found", 404);
  }
  return job;
}

function serialize(job: JobRow) {
  const status = job.status === "queued" ? "processing" : job.status;
  const base = {
    draftId: job.id,
    status,
    expiresAt: job.expires_at,
    modelContractRevision: job.model_contract_revision,
  };
  if ((job.status === "choose_model" || job.status === "ready") && job.result_json) {
    return { ...base, ...JSON.parse(job.result_json) };
  }
  if (job.status === "failed") {
    return { ...base, error: { code: job.error_code ?? "AI_PROVIDER_UNAVAILABLE" } };
  }
  return base;
}

async function enqueue(env: Bindings, message: RegistryCreationDraftQueueMessage): Promise<void> {
  try {
    await env.CREATION_DRAFT_QUEUE.send(message);
  } catch {
    await env.DB.prepare(`UPDATE creation_draft_jobs
      SET status='failed',error_code='AI_QUEUE_UNAVAILABLE',input_text=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND generation=?`)
      .bind(message.draftId, message.generation).run();
    throw new ApiError("AI_QUEUE_UNAVAILABLE", "AI creation queue is unavailable", 502);
  }
}

function providerError(error: unknown): string {
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
  return error instanceof ApiError && error.code === "AI_INVALID_RESPONSE"
    ? "AI_INVALID_RESPONSE"
    : "AI_PROVIDER_UNAVAILABLE";
}

export function registerRegistryCreationDraftRoutes(app: App): void {
  app.post(
    "/api/v1/spaces/:spaceId/creation-drafts",
    requireScope("creation-drafts:write"),
    async (c) => {
      const principal = c.get("principal");
      requireUser(principal);
      const spaceId = c.req.param("spaceId");
      await requireSpacePermission(c.env, principal, spaceId, "read");
      await spaceContext(c.env, spaceId, principal.id);

      const models = await listWritableCreationModels(c.env, principal.clientId);
      if (!models.length) {
        throw new ApiError(
          "CREATION_DRAFT_NO_MODELS",
          "Application has no writable published models",
          403,
        );
      }
      const contract = await getOrCreateActiveModelContract(c.env);
      const input = createInput(await body(c));
      const rate = await c.env.AI_RATE_LIMITER.limit({ key: principal.id });
      if (!rate.success) {
        throw new ApiError("AI_RATE_LIMITED", "AI creation rate limit reached", 429);
      }

      const draftId = createId("drf");
      const expiresAt = new Date(Date.now() + JOB_TTL_MS).toISOString();
      await c.env.DB.prepare(`INSERT INTO creation_draft_jobs(
        id,space_id,requested_by_user_id,requesting_client_id,model_contract_revision,
        status,generation,input_text,viewing_timezone,expires_at
      ) VALUES(?,?,?,?,?,'queued',1,?,?,?)`)
        .bind(
          draftId,
          spaceId,
          principal.id,
          principal.clientId,
          contract.id,
          input.text,
          input.viewingTimezone,
          expiresAt,
        ).run();
      await enqueue(c.env, { draftId, generation: 1 });
      return c.json(success({
        draftId,
        status: "processing",
        expiresAt,
        modelContractRevision: contract.id,
      }), 202);
    },
  );

  app.get(
    "/api/v1/spaces/:spaceId/creation-drafts/:draftId",
    requireScope("creation-drafts:read"),
    async (c) => {
      const principal = c.get("principal");
      requireUser(principal);
      const spaceId = c.req.param("spaceId");
      await requireSpacePermission(c.env, principal, spaceId, "read");
      return c.json(success(serialize(
        await ownedJob(c.env, spaceId, c.req.param("draftId"), principal.id),
      )));
    },
  );

  app.post(
    "/api/v1/spaces/:spaceId/creation-drafts/:draftId/choose-model",
    requireScope("creation-drafts:write"),
    async (c) => {
      const principal = c.get("principal");
      requireUser(principal);
      const spaceId = c.req.param("spaceId");
      await requireSpacePermission(c.env, principal, spaceId, "read");
      await spaceContext(c.env, spaceId, principal.id);

      const job = await ownedJob(c.env, spaceId, c.req.param("draftId"), principal.id);
      if (job.status !== "choose_model") {
        throw new ApiError(
          "CREATION_DRAFT_STATE_CONFLICT",
          "Creation draft is not awaiting a model",
          409,
        );
      }
      const target = modelInput(await body(c));
      const candidates = job.result_json
        ? (JSON.parse(job.result_json) as { candidateModels?: string[] }).candidateModels ?? []
        : [];
      const writable = await listWritableCreationModels(c.env, job.requesting_client_id);
      if (!candidates.includes(target) || !writable.some((model) => model.key === target)) {
        throw new ApiError(
          "VALIDATION_ERROR",
          "targetModelKey is not an available candidate",
          422,
        );
      }

      const generation = job.generation + 1;
      const result = await c.env.DB.prepare(`UPDATE creation_draft_jobs
        SET status='queued',generation=?,target_model_key=?,result_json=NULL,error_code=NULL,
          started_at=NULL,completed_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=? AND generation=? AND status='choose_model'`)
        .bind(generation, target, job.id, job.generation).run();
      if (!result.meta.changes) {
        throw new ApiError("CREATION_DRAFT_STATE_CONFLICT", "Creation draft changed", 409);
      }
      await enqueue(c.env, { draftId: job.id, generation });
      return c.json(success({
        draftId: job.id,
        status: "processing",
        expiresAt: job.expires_at,
        modelContractRevision: job.model_contract_revision,
      }), 202);
    },
  );
}

async function processOne(
  env: Bindings,
  dependencies: RegistryCreationDraftDependencies,
  message: RegistryCreationDraftQueueMessage,
): Promise<void> {
  const claim = await env.DB.prepare(`UPDATE creation_draft_jobs
    SET status='processing',attempt_count=attempt_count+1,
      started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND generation=? AND status='queued'
      AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(message.draftId, message.generation).run();
  if (!claim.meta.changes) return;

  const job = await env.DB.prepare(
    "SELECT * FROM creation_draft_jobs WHERE id=? AND generation=?",
  ).bind(message.draftId, message.generation).first<JobRow>();
  if (!job || !job.input_text) return;

  try {
    const activeContract = await getOrCreateActiveModelContract(env);
    if (activeContract.id !== job.model_contract_revision) {
      throw new ApiError(
        "CREATION_DRAFT_MODEL_CONTRACT_CHANGED",
        "Model contract changed; create a new draft",
        409,
      );
    }

    const models = await listWritableCreationModels(env, job.requesting_client_id);
    if (!models.length) {
      throw new ApiError(
        "CREATION_DRAFT_NO_MODELS",
        "Application has no writable published models",
        403,
      );
    }
    if (job.target_model_key && !models.some((model) => model.key === job.target_model_key)) {
      throw new ApiError(
        "CREATION_DRAFT_MODEL_UNAVAILABLE",
        "Selected model is no longer writable",
        409,
      );
    }

    const startedAt = dependencies.now();
    const context = await spaceContext(env, job.space_id, job.requested_by_user_id);
    const providerResult = await dependencies.createProvider(env).generate({
      text: job.input_text,
      currentInstant: startedAt.toISOString(),
      spaceTimezone: context.timezone,
      viewingTimezone: job.viewing_timezone,
      responseSchema: buildRegistryCreationDraftSchema(models),
      models: creationDraftModelDescriptors(models),
      people: context.people.map(({ ref, name }) => ({ ref, name })),
      requestingPersonRef: context.requestingPersonRef,
      ...(job.target_model_key ? { targetModelKey: job.target_model_key } : {}),
    });
    const normalized = normalizeRegistryCreationDraft(providerResult.output, {
      models,
      people: context.people,
      ...(job.target_model_key ? { targetModelKey: job.target_model_key } : {}),
    });
    const finalStatus = normalized.status === "choose_model" ? "choose_model" : "ready";

    await env.DB.prepare(`UPDATE creation_draft_jobs
      SET status=?,result_json=?,error_code=NULL,
        input_text=CASE WHEN ?='ready' THEN NULL ELSE input_text END,
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND generation=? AND status='processing'`)
      .bind(finalStatus, JSON.stringify(normalized), finalStatus, job.id, job.generation).run();

    console.info("Registry creation draft processed", {
      draftId: job.id,
      status: finalStatus,
      modelContractRevision: job.model_contract_revision,
      providerStatus: providerResult.metadata.providerStatus,
      totalTokens: providerResult.metadata.usage?.totalTokens,
    });
  } catch (error) {
    const code = providerError(error);
    await env.DB.prepare(`UPDATE creation_draft_jobs
      SET status='failed',result_json=NULL,error_code=?,input_text=NULL,
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND generation=? AND status='processing'`)
      .bind(code, job.id, job.generation).run();
    console.warn("Registry creation draft failed", {
      draftId: job.id,
      errorCategory: code,
    });
  }
}

export async function processRegistryCreationDraftQueue(
  batch: MessageBatch<RegistryCreationDraftQueueMessage>,
  env: Bindings,
  dependencies: RegistryCreationDraftDependencies,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processOne(env, dependencies, message.body);
      message.ack();
    } catch (error) {
      console.error("Registry creation draft queue message failed", {
        draftId: message.body.draftId,
        generation: message.body.generation,
        error,
      });
      message.retry();
    }
  }
}

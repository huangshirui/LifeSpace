import type { Context, Hono } from "hono";
import { requireScope } from "./auth";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { canonicalModelDefinition, type ModelDefinition, type ModelValidationIssue } from "./model-definition";
import { createModelAdminAiProvider, type ModelAdminAiOutput } from "./model-admin-ai-provider";
import { diffModelDefinition, type ModelDefinitionDiff } from "./model-proposal";
import {
  getPublishedModel,
  listPublishedModels,
  publishModelDefinition,
  validateDefinition,
  type ModelCompatibility,
  type PublishedModel,
} from "./model-registry";
import { OpenAICompatibleProviderError } from "./registry-openai-provider";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type Body = Record<string, unknown>;
type ProposalStatus = "draft" | "proposed" | "published" | "discarded";

type ProposalRow = {
  id: string;
  model_key: string;
  definition_json: string;
  definition_version: number;
  validation_json: string | null;
  base_published_version: number | null;
  source: "ai";
  proposal_status: ProposalStatus;
  instruction_text: string | null;
  schema_hash: string | null;
  diff_json: string | null;
  recommended_compatibility: ModelCompatibility | null;
  ai_summary: string | null;
  ai_warnings_json: string | null;
  published_model_id: string | null;
  created_by_type: Principal["type"];
  created_by_id: string;
  created_by_name_snapshot: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  discarded_at: string | null;
};

export type ModelAdminAiProvider = {
  generate(input: Parameters<ReturnType<typeof createModelAdminAiProvider>["generate"]>[0]): ReturnType<ReturnType<typeof createModelAdminAiProvider>["generate"]>;
};

export type CreateModelProposalInput = {
  instruction: string;
  targetModelKey?: string;
};

const PROPOSAL_STATUS = new Set<ProposalStatus>(["draft", "proposed", "published", "discarded"]);

function requireService(principal: Principal): void {
  if (principal.type !== "service") {
    throw new ApiError("FORBIDDEN", "AI model administration requires a service principal", 403);
  }
}

async function body(context: Context<AppEnv>): Promise<Body> {
  const value = await context.req.json<unknown>().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  return value as Body;
}

function createInput(input: Body): CreateModelProposalInput {
  if (Object.keys(input).some((key) => key !== "instruction" && key !== "targetModelKey")) {
    throw new ApiError("INVALID_REQUEST", "AI model proposal accepts only instruction and targetModelKey", 400);
  }
  if (typeof input.instruction !== "string" || input.instruction.trim().length < 1 || input.instruction.trim().length > 5000) {
    throw new ApiError("VALIDATION_ERROR", "instruction must contain 1-5000 characters", 422);
  }
  if (input.targetModelKey !== undefined && (typeof input.targetModelKey !== "string" || !/^[a-z][a-z0-9_]{1,62}$/u.test(input.targetModelKey))) {
    throw new ApiError("VALIDATION_ERROR", "targetModelKey must be a valid model key", 422);
  }
  return {
    instruction: input.instruction.trim(),
    ...(typeof input.targetModelKey === "string" ? { targetModelKey: input.targetModelKey } : {}),
  };
}

function compatibility(value: unknown): ModelCompatibility {
  if (value !== "initial" && value !== "compatible" && value !== "breaking") {
    throw new ApiError("INVALID_REQUEST", "compatibility must be initial, compatible, or breaking", 400);
  }
  return value;
}

function proposalId(): string {
  return `mdr_ai_${crypto.randomUUID().replaceAll("-", "")}`;
}

function safeJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function proposalDto(row: ProposalRow) {
  return {
    id: row.id,
    status: row.proposal_status,
    modelKey: row.model_key,
    baseModelVersion: row.base_published_version,
    instruction: row.instruction_text,
    definition: safeJson<Record<string, unknown>>(row.definition_json, {}),
    validation: safeJson<Record<string, unknown>>(row.validation_json, { valid: false }),
    schemaHash: row.schema_hash,
    diff: safeJson<ModelDefinitionDiff | null>(row.diff_json, null),
    recommendedCompatibility: row.recommended_compatibility,
    ai: {
      summary: row.ai_summary,
      warnings: safeJson<string[]>(row.ai_warnings_json, []),
    },
    publishedModelId: row.published_model_id,
    createdBy: {
      type: row.created_by_type,
      id: row.created_by_id,
      displayName: row.created_by_name_snapshot,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    discardedAt: row.discarded_at,
  };
}

async function proposal(env: Bindings, id: string): Promise<ProposalRow> {
  const row = await env.DB.prepare(`SELECT * FROM model_definition_drafts
    WHERE id=? AND source='ai' LIMIT 1`).bind(id).first<ProposalRow>();
  if (!row) throw new ApiError("MODEL_PROPOSAL_NOT_FOUND", "AI model proposal not found", 404);
  return row;
}

function invalidIssue(code: string, message: string): ModelValidationIssue {
  return { path: "$", code, message };
}

function parseAiDefinition(output: ModelAdminAiOutput): { value: unknown; issue?: ModelValidationIssue } {
  try {
    const value = JSON.parse(output.definitionJson) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: {}, issue: invalidIssue("AI_DEFINITION_NOT_OBJECT", "AI definitionJson must encode one JSON object") };
    }
    return { value };
  } catch {
    return { value: {}, issue: invalidIssue("AI_DEFINITION_INVALID_JSON", "AI definitionJson is not valid JSON") };
  }
}

function proposedKey(value: unknown, fallback: string): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const key = (value as Record<string, unknown>).key;
    if (typeof key === "string" && key) return key;
  }
  return fallback;
}

function providerError(error: unknown): ApiError {
  if (!(error instanceof OpenAICompatibleProviderError)) {
    return new ApiError("AI_PROVIDER_UNAVAILABLE", "AI model proposal provider is unavailable", 502);
  }
  if (error.code === "AI_NOT_CONFIGURED") return new ApiError(error.code, error.message, 503);
  if (error.code === "AI_TIMEOUT") return new ApiError("AI_PROVIDER_TIMEOUT", error.message, 504);
  if (error.code === "AI_RATE_LIMITED") return new ApiError(error.code, error.message, 429);
  if (error.code === "AI_INVALID_RESPONSE") return new ApiError(error.code, error.message, 502);
  if (error.code === "AI_AUTHENTICATION_FAILED" || error.code === "AI_ACCESS_DENIED" || error.code === "AI_QUOTA_EXCEEDED") {
    return new ApiError(error.code, error.message, 502);
  }
  return new ApiError("AI_PROVIDER_UNAVAILABLE", error.message, 502);
}

function modelCatalog(models: PublishedModel[]) {
  return models.map((model) => ({
    key: model.key,
    route: model.route,
    version: model.version,
    displayName: model.definition.display.singular,
    description: model.definition.description ?? null,
  }));
}

export async function createAiModelProposal(
  env: Bindings,
  principal: Principal,
  input: CreateModelProposalInput,
  provider: ModelAdminAiProvider,
  now = new Date(),
) {
  requireService(principal);
  const existing = await listPublishedModels(env);
  const base = input.targetModelKey
    ? existing.find((model) => model.key === input.targetModelKey) ?? null
    : null;
  if (input.targetModelKey && !base) {
    throw new ApiError("MODEL_NOT_FOUND", "targetModelKey must name a currently published model", 404);
  }

  let generated: Awaited<ReturnType<ModelAdminAiProvider["generate"]>>;
  try {
    generated = await provider.generate({
      instruction: input.instruction,
      existingModels: modelCatalog(existing),
      ...(base ? { targetModel: { key: base.key, version: base.version, definition: base.definition } } : {}),
    });
  } catch (error) {
    throw providerError(error);
  }

  const parsed = parseAiDefinition(generated.output);
  const extraIssues: ModelValidationIssue[] = parsed.issue ? [parsed.issue] : [];
  const key = proposedKey(parsed.value, input.targetModelKey ?? `invalid_${crypto.randomUUID().slice(0, 8)}`);

  if (base && key !== base.key) {
    extraIssues.push(invalidIssue("AI_TARGET_MODEL_MISMATCH", `AI proposal key must remain ${base.key}`));
  }
  if (!base && existing.some((model) => model.key === key)) {
    extraIssues.push(invalidIssue("AI_NEW_MODEL_KEY_CONFLICT", `Model ${key} already exists; use targetModelKey to propose an update`));
  }

  const validation = parsed.issue ? { valid: false as const, issues: [] as ModelValidationIssue[] } : await validateDefinition(parsed.value);
  const issues = [
    ...extraIssues,
    ...(validation.valid ? [] : validation.issues),
  ];
  const valid = issues.length === 0 && validation.valid;
  const normalizedDefinition = valid ? validation.definition : parsed.value;
  const diff = valid ? diffModelDefinition(base, validation.definition) : null;
  const timestamp = now.toISOString();
  const id = proposalId();
  const proposalStatus: ProposalStatus = valid ? "proposed" : "draft";
  const validationJson = valid
    ? JSON.stringify({ valid: true, schemaHash: validation.schemaHash })
    : JSON.stringify({ valid: false, issues });

  await env.DB.prepare(`INSERT INTO model_definition_drafts(
    id,model_key,definition_json,definition_version,validation_json,base_published_version,
    created_by_type,created_by_id,created_by_name_snapshot,created_at,updated_at,
    source,proposal_status,instruction_text,schema_hash,diff_json,recommended_compatibility,
    ai_summary,ai_warnings_json
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id,
    key,
    valid ? canonicalModelDefinition(normalizedDefinition as ModelDefinition) : JSON.stringify(normalizedDefinition),
    1,
    validationJson,
    base?.version ?? null,
    principal.type,
    principal.id,
    principal.id,
    timestamp,
    timestamp,
    "ai",
    proposalStatus,
    input.instruction,
    valid ? validation.schemaHash : null,
    diff ? JSON.stringify(diff) : null,
    diff?.recommendedCompatibility ?? null,
    generated.output.summary,
    JSON.stringify(generated.output.warnings),
  ).run();

  const stored = await proposal(env, id);
  return proposalDto(stored);
}

export async function listAiModelProposals(env: Bindings, status?: ProposalStatus) {
  if (status) {
    const rows = await env.DB.prepare(`SELECT * FROM model_definition_drafts
      WHERE source='ai' AND proposal_status=? ORDER BY updated_at DESC,id DESC LIMIT 100`)
      .bind(status).all<ProposalRow>();
    return rows.results.map(proposalDto);
  }
  const rows = await env.DB.prepare(`SELECT * FROM model_definition_drafts
    WHERE source='ai' ORDER BY updated_at DESC,id DESC LIMIT 100`).all<ProposalRow>();
  return rows.results.map(proposalDto);
}

export async function getAiModelProposal(env: Bindings, id: string) {
  return proposalDto(await proposal(env, id));
}

export async function discardAiModelProposal(env: Bindings, id: string, now = new Date()) {
  const current = await proposal(env, id);
  if (current.proposal_status === "published") {
    throw new ApiError("MODEL_PROPOSAL_STATE_CONFLICT", "Published proposal cannot be discarded", 409);
  }
  if (current.proposal_status === "discarded") return proposalDto(current);
  const timestamp = now.toISOString();
  const result = await env.DB.prepare(`UPDATE model_definition_drafts
    SET proposal_status='discarded',discarded_at=?,updated_at=?
    WHERE id=? AND source='ai' AND proposal_status IN ('draft','proposed')`)
    .bind(timestamp, timestamp, id).run();
  if (!result.meta.changes) throw new ApiError("MODEL_PROPOSAL_STATE_CONFLICT", "Proposal state changed", 409);
  return proposalDto(await proposal(env, id));
}

export async function publishAiModelProposal(
  env: Bindings,
  principal: Principal,
  id: string,
  requestedCompatibility: ModelCompatibility,
  now = new Date(),
) {
  requireService(principal);
  const currentProposal = await proposal(env, id);
  if (currentProposal.proposal_status !== "proposed") {
    throw new ApiError("MODEL_PROPOSAL_STATE_CONFLICT", "Only a valid proposed draft can be published", 409);
  }

  const currentModel = await getPublishedModel(env, currentProposal.model_key);
  if (currentProposal.base_published_version === null) {
    if (currentModel) throw new ApiError("MODEL_PROPOSAL_STALE", "A model with this key was published after the proposal was generated", 409);
    if (requestedCompatibility !== "initial") {
      throw new ApiError("INVALID_MODEL_COMPATIBILITY", "New-model proposal must publish with compatibility=initial", 400);
    }
  } else {
    if (!currentModel || currentModel.version !== currentProposal.base_published_version) {
      throw new ApiError("MODEL_PROPOSAL_STALE", "Published model changed after the proposal was generated", 409);
    }
    if (requestedCompatibility === "initial") {
      throw new ApiError("INVALID_MODEL_COMPATIBILITY", "Existing-model proposal cannot publish with compatibility=initial", 400);
    }
  }

  if (currentProposal.recommended_compatibility === "breaking" && requestedCompatibility !== "breaking") {
    throw new ApiError(
      "MODEL_PROPOSAL_COMPATIBILITY_UNDERSTATED",
      "Core classified this proposal as breaking; publish requires compatibility=breaking",
      409,
    );
  }

  const definition = safeJson<unknown>(currentProposal.definition_json, null);
  const validation = await validateDefinition(definition);
  if (!validation.valid || validation.schemaHash !== currentProposal.schema_hash) {
    throw new ApiError("MODEL_PROPOSAL_INVALID", "Stored proposal no longer validates against the current Model Definition rules", 409);
  }

  const published = await publishModelDefinition(env, principal, validation.definition, requestedCompatibility);
  const timestamp = now.toISOString();
  const result = await env.DB.prepare(`UPDATE model_definition_drafts
    SET proposal_status='published',published_model_id=?,published_at=?,updated_at=?
    WHERE id=? AND source='ai' AND proposal_status='proposed'`)
    .bind(published.id, timestamp, timestamp, id).run();
  if (!result.meta.changes) {
    throw new ApiError("MODEL_PROPOSAL_STATE_CONFLICT", "Model published but proposal audit state changed concurrently", 409);
  }
  return {
    proposal: proposalDto(await proposal(env, id)),
    publishedModel: {
      id: published.id,
      key: published.key,
      route: published.route,
      version: published.version,
      schemaHash: published.schemaHash,
      compatibility: published.compatibility,
      definition: published.definition,
      publishedAt: published.publishedAt,
    },
  };
}

export function defaultModelAdminAiProvider(env: Bindings) {
  return createModelAdminAiProvider({
    baseUrl: env.AI_BASE_URL ?? "",
    apiKey: env.AI_API_KEY ?? "",
    model: env.AI_MODEL ?? "",
    promptAppendix: env.AI_PROMPT_APPENDIX,
    appTitle: "LifeSpace Model Admin",
    appReferer: "https://core.aisr.online",
    requireParameters: true,
  });
}

export function registerModelAdminAiRoutes(app: App): void {
  app.get("/api/v1/model-admin/ai/proposals", requireScope("models:manage"), async (context) => {
    const principal = context.get("principal");
    requireService(principal);
    const statusValue = new URL(context.req.url).searchParams.get("status");
    if (statusValue && !PROPOSAL_STATUS.has(statusValue as ProposalStatus)) {
      throw new ApiError("INVALID_QUERY", "status must be draft, proposed, published, or discarded", 400);
    }
    return context.json(success(await listAiModelProposals(context.env, statusValue as ProposalStatus | undefined)));
  });

  app.post("/api/v1/model-admin/ai/proposals", requireScope("models:manage"), async (context) => {
    const principal = context.get("principal");
    requireService(principal);
    const rate = await context.env.AI_RATE_LIMITER.limit({ key: `model-admin:${principal.id}` });
    if (!rate.success) throw new ApiError("AI_RATE_LIMITED", "AI model proposal rate limit reached", 429);
    const proposalInput = createInput(await body(context));
    const created = await createAiModelProposal(
      context.env,
      principal,
      proposalInput,
      defaultModelAdminAiProvider(context.env),
    );
    return context.json(success(created), 201);
  });

  app.get("/api/v1/model-admin/ai/proposals/:proposalId", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    return context.json(success(await getAiModelProposal(context.env, context.req.param("proposalId"))));
  });

  app.post("/api/v1/model-admin/ai/proposals/:proposalId/publish", requireScope("models:manage"), async (context) => {
    const principal = context.get("principal");
    requireService(principal);
    const input = await body(context);
    if (Object.keys(input).some((key) => key !== "compatibility")) {
      throw new ApiError("INVALID_REQUEST", "Proposal publish accepts only compatibility", 400);
    }
    const result = await publishAiModelProposal(
      context.env,
      principal,
      context.req.param("proposalId"),
      compatibility(input.compatibility),
    );
    return context.json(success(result), 201);
  });

  app.post("/api/v1/model-admin/ai/proposals/:proposalId/discard", requireScope("models:manage"), async (context) => {
    requireService(context.get("principal"));
    const input = await body(context);
    if (Object.keys(input).length) throw new ApiError("INVALID_REQUEST", "Proposal discard body must be empty", 400);
    return context.json(success(await discardAiModelProposal(context.env, context.req.param("proposalId"))));
  });
}

import type { Bindings } from "./env";
import { ApiError } from "./http";
import type { ModelDefinition } from "./model-definition";
import type { ModelCompatibility } from "./model-registry";

export type ProposalPublicationEvidence = {
  id: string;
  key: string;
  version: number;
  schemaHash: string;
  compatibility: ModelCompatibility;
  definition: ModelDefinition;
  publishedAt: string;
};

type ClaimRow = {
  proposal_status: string;
  publication_token: string | null;
  publication_started_at: string | null;
  published_model_id: string | null;
};

type ModelRow = {
  id: string;
  model_key: string;
  version: number;
  definition_json: string;
  schema_hash: string;
  compatibility: ModelCompatibility;
  published_at: string;
};

const CLAIM_STALE_MS = 5 * 60 * 1000;

function token(): string {
  return crypto.randomUUID();
}

function evidence(row: ModelRow): ProposalPublicationEvidence {
  let definition: ModelDefinition;
  try {
    definition = JSON.parse(row.definition_json) as ModelDefinition;
  } catch {
    throw new ApiError("MODEL_REGISTRY_CORRUPT", "Published proposal model has invalid definition JSON", 500);
  }
  return {
    id: row.id,
    key: row.model_key,
    version: row.version,
    schemaHash: row.schema_hash,
    compatibility: row.compatibility,
    definition,
    publishedAt: row.published_at,
  };
}

export async function findProposalPublicationEvidence(
  env: Bindings,
  modelKey: string,
  expectedVersion: number,
  schemaHash: string | null,
): Promise<ProposalPublicationEvidence | null> {
  if (!schemaHash) return null;
  const row = await env.DB.prepare(`SELECT
      id,model_key,version,definition_json,schema_hash,compatibility,published_at
    FROM model_definitions
    WHERE model_key=? AND version=? AND schema_hash=?
    LIMIT 1`)
    .bind(modelKey, expectedVersion, schemaHash)
    .first<ModelRow>();
  return row ? evidence(row) : null;
}

async function claimRow(env: Bindings, proposalId: string): Promise<ClaimRow> {
  const row = await env.DB.prepare(`SELECT proposal_status,publication_token,publication_started_at,published_model_id
    FROM model_definition_drafts WHERE id=? AND source='ai' LIMIT 1`)
    .bind(proposalId)
    .first<ClaimRow>();
  if (!row) throw new ApiError("MODEL_PROPOSAL_NOT_FOUND", "AI model proposal not found", 404);
  return row;
}

export async function finalizeProposalPublication(
  env: Bindings,
  proposalId: string,
  publicationToken: string,
  published: ProposalPublicationEvidence,
  now = new Date(),
): Promise<void> {
  const timestamp = now.toISOString();
  const result = await env.DB.prepare(`UPDATE model_definition_drafts
    SET proposal_status='published',published_model_id=?,published_at=?,updated_at=?,
      publication_token=NULL,publication_started_at=NULL
    WHERE id=? AND source='ai' AND proposal_status='proposed' AND publication_token=?`)
    .bind(published.id, timestamp, timestamp, proposalId, publicationToken)
    .run();
  if (result.meta.changes) return;

  const current = await claimRow(env, proposalId);
  if (current.proposal_status === "published" && current.published_model_id === published.id) return;
  throw new ApiError(
    "MODEL_PROPOSAL_STATE_CONFLICT",
    "Published model exists but proposal audit state could not be finalized",
    409,
  );
}

export async function releaseProposalPublicationClaim(
  env: Bindings,
  proposalId: string,
  publicationToken: string,
  now = new Date(),
): Promise<void> {
  await env.DB.prepare(`UPDATE model_definition_drafts
    SET publication_token=NULL,publication_started_at=NULL,updated_at=?
    WHERE id=? AND source='ai' AND proposal_status='proposed' AND publication_token=?`)
    .bind(now.toISOString(), proposalId, publicationToken)
    .run();
}

export async function acquireProposalPublicationClaim(
  env: Bindings,
  input: {
    proposalId: string;
    modelKey: string;
    expectedVersion: number;
    schemaHash: string;
  },
  now = new Date(),
): Promise<{
  publicationToken: string;
  recovered: ProposalPublicationEvidence | null;
}> {
  let current = await claimRow(env, input.proposalId);
  if (current.proposal_status !== "proposed") {
    throw new ApiError("MODEL_PROPOSAL_STATE_CONFLICT", "Only a proposed draft can be published", 409);
  }

  if (current.publication_token) {
    const recovered = await findProposalPublicationEvidence(
      env,
      input.modelKey,
      input.expectedVersion,
      input.schemaHash,
    );
    if (recovered) {
      await finalizeProposalPublication(env, input.proposalId, current.publication_token, recovered, now);
      return { publicationToken: current.publication_token, recovered };
    }

    const started = current.publication_started_at ? Date.parse(current.publication_started_at) : Number.NaN;
    const stale = Number.isNaN(started) || now.getTime() - started > CLAIM_STALE_MS;
    if (!stale) {
      throw new ApiError("MODEL_PROPOSAL_PUBLISH_IN_PROGRESS", "Proposal publication is already in progress", 409);
    }

    const released = await env.DB.prepare(`UPDATE model_definition_drafts
      SET publication_token=NULL,publication_started_at=NULL,updated_at=?
      WHERE id=? AND source='ai' AND proposal_status='proposed' AND publication_token=?`)
      .bind(now.toISOString(), input.proposalId, current.publication_token)
      .run();
    if (!released.meta.changes) {
      throw new ApiError("MODEL_PROPOSAL_PUBLISH_IN_PROGRESS", "Proposal publication claim changed", 409);
    }
    current = await claimRow(env, input.proposalId);
  }

  const publicationToken = token();
  const claimed = await env.DB.prepare(`UPDATE model_definition_drafts
    SET publication_token=?,publication_started_at=?,updated_at=?
    WHERE id=? AND source='ai' AND proposal_status='proposed' AND publication_token IS NULL`)
    .bind(publicationToken, now.toISOString(), now.toISOString(), input.proposalId)
    .run();
  if (!claimed.meta.changes) {
    throw new ApiError("MODEL_PROPOSAL_PUBLISH_IN_PROGRESS", "Proposal publication is already in progress", 409);
  }
  return { publicationToken, recovered: null };
}

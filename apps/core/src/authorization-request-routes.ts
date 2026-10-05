import type { Hono } from "hono";
import {
  delegationIssueDtos,
  delegationIssueStatements,
  parseCreateDelegationBody,
  prepareDelegationIssues,
} from "./delegation-routes";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type AuthorizationRequestStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";
type RequestedItem = {
  scope: {
    target: { type: "space" | "model" | "record"; id: string };
    maxAccess: "free_busy" | "read" | "write" | "manage";
  };
  constraints: {
    maxUses?: 1;
    expiresAt?: string;
    remainingRedelegationDepth: number;
  };
};
type Correlation = { sessionId?: string; conversationId?: string };
type AuthorizationRequestRow = {
  id: string;
  source_space_id: string;
  application_id: string;
  requesting_agent_id: string;
  principal_user_id: string;
  status: AuthorizationRequestStatus;
  dedupe_key: string;
  requested_items_json: string;
  item_count: number;
  correlation_json: string | null;
  request_expires_at: string;
  created_at: string;
  decided_at: string | null;
};

type CreateAuthorizationRequestBody = {
  principalUserId?: unknown;
  items?: unknown;
  requestTtlMinutes?: unknown;
  correlation?: unknown;
};
type ReviewAuthorizationRequestBody = {
  reviewToken?: unknown;
  confirmation?: unknown;
};

const DEFAULT_REQUEST_TTL_MINUTES = 60;
const MIN_REQUEST_TTL_MINUTES = 1;
const MAX_REQUEST_TTL_MINUTES = 1440;
const MAX_REQUEST_ITEMS = 20;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const now = () => new Date().toISOString();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function requireRequestingAgent(principal: Principal): string {
  if (principal.type !== "agent" || principal.actor || principal.purpose !== "agent_api") {
    throw new ApiError(
      "FORBIDDEN",
      "Authorization Request operations require a direct Agent API credential",
      403,
    );
  }
  if (!/^agt_[A-Za-z0-9_-]+$/u.test(principal.id)) {
    throw new ApiError("FORBIDDEN", "Verified Agent identity is invalid", 403);
  }
  return principal.id;
}

function parseCorrelation(value: unknown): Correlation | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "correlation must be an object", 400);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !["sessionId", "conversationId"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported correlation field ${unknown}`, 400);
  const result: Correlation = {};
  for (const key of ["sessionId", "conversationId"] as const) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 256) {
      throw new ApiError("INVALID_REQUEST", `correlation.${key} must be a non-empty string up to 256 characters`, 400);
    }
    result[key] = raw.trim();
  }
  return Object.keys(result).length ? result : null;
}

function parseRequestTtlMinutes(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_REQUEST_TTL_MINUTES;
  if (!Number.isInteger(value)
      || Number(value) < MIN_REQUEST_TTL_MINUTES
      || Number(value) > MAX_REQUEST_TTL_MINUTES) {
    throw new ApiError(
      "INVALID_REQUEST",
      `requestTtlMinutes must be an integer between ${MIN_REQUEST_TTL_MINUTES} and ${MAX_REQUEST_TTL_MINUTES}`,
      400,
    );
  }
  return Number(value);
}

function normalizeRequestedItems(value: unknown, agentId: string): RequestedItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REQUEST_ITEMS) {
    throw new ApiError(
      "INVALID_REQUEST",
      `items must contain between 1 and ${MAX_REQUEST_ITEMS} requested Delegation scopes`,
      400,
    );
  }
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError("INVALID_REQUEST", "Authorization Request item must be an object", 400);
    }
    const input = raw as Record<string, unknown>;
    const unknown = Object.keys(input).find((key) => !["scope", "constraints"].includes(key));
    if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported Authorization Request item field ${unknown}`, 400);
    const parsed = parseCreateDelegationBody({
      actor: { type: "agent", id: agentId },
      scope: input.scope,
      constraints: input.constraints,
    });
    return {
      scope: parsed.scope,
      constraints: {
        ...(parsed.constraints.maxUses === 1 ? { maxUses: 1 as const } : {}),
        ...(parsed.constraints.expiresAt ? { expiresAt: parsed.constraints.expiresAt } : {}),
        remainingRedelegationDepth: parsed.constraints.remainingRedelegationDepth,
      },
    };
  });
}

function parseCreateBody(value: unknown, agentId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  const body = value as CreateAuthorizationRequestBody;
  const unknown = Object.keys(body)
    .find((key) => !["principalUserId", "items", "requestTtlMinutes", "correlation"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported Authorization Request field ${unknown}`, 400);
  if (typeof body.principalUserId !== "string" || !/^usr_[A-Za-z0-9_-]+$/u.test(body.principalUserId)) {
    throw new ApiError("INVALID_REQUEST", "principalUserId must be a valid usr_* identifier", 400);
  }
  return {
    principalUserId: body.principalUserId,
    items: normalizeRequestedItems(body.items, agentId),
    requestTtlMinutes: parseRequestTtlMinutes(body.requestTtlMinutes),
    correlation: parseCorrelation(body.correlation),
  };
}

function parseReviewBody(value: unknown): { reviewToken: string; confirmation?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
  }
  const body = value as ReviewAuthorizationRequestBody;
  const unknown = Object.keys(body).find((key) => !["reviewToken", "confirmation"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported review field ${unknown}`, 400);
  if (typeof body.reviewToken !== "string" || !/^arv_[A-Za-z0-9_-]+$/u.test(body.reviewToken)) {
    throw new ApiError("INVALID_REQUEST", "reviewToken must be a valid opaque Authorization Review token", 400);
  }
  if (body.confirmation !== undefined
      && (!body.confirmation || typeof body.confirmation !== "object" || Array.isArray(body.confirmation))) {
    throw new ApiError("INVALID_REQUEST", "confirmation must be a structured object when supplied", 400);
  }
  return { reviewToken: body.reviewToken, ...(body.confirmation === undefined ? {} : { confirmation: body.confirmation }) };
}

function requestedItems(row: AuthorizationRequestRow): RequestedItem[] {
  return JSON.parse(row.requested_items_json) as RequestedItem[];
}

function correlation(row: AuthorizationRequestRow): Correlation | null {
  return row.correlation_json ? JSON.parse(row.correlation_json) as Correlation : null;
}

function confirmationProjection(row: AuthorizationRequestRow) {
  return {
    requestId: row.id,
    principal: { type: "user" as const, id: row.principal_user_id },
    actor: { type: "agent" as const, id: row.requesting_agent_id },
    applicationId: row.application_id,
    spaceId: row.source_space_id,
    items: requestedItems(row),
    requestExpiresAt: row.request_expires_at,
  };
}

function requestDto(row: AuthorizationRequestRow) {
  return {
    id: row.id,
    status: row.status,
    principal: { type: "user" as const, id: row.principal_user_id },
    actor: { type: "agent" as const, id: row.requesting_agent_id },
    applicationId: row.application_id,
    spaceId: row.source_space_id,
    items: requestedItems(row),
    requestExpiresAt: row.request_expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    correlation: correlation(row),
    confirmation: confirmationProjection(row),
  };
}

async function materializeExpiry(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requestId: string,
  agentId: string,
): Promise<void> {
  const expiredAt = now();
  await env.DB.prepare(`UPDATE authorization_requests
    SET status='expired',decided_at=COALESCE(decided_at,?)
    WHERE id=? AND source_space_id=? AND application_id=? AND requesting_agent_id=?
      AND status='pending' AND request_expires_at<=?`)
    .bind(expiredAt, requestId, spaceId, principal.clientId, agentId, expiredAt)
    .run();
}

async function loadOwnedRequest(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requestId: string,
  agentId: string,
): Promise<AuthorizationRequestRow> {
  if (!/^arq_[A-Za-z0-9_-]+$/u.test(requestId)) {
    throw new ApiError("INVALID_REQUEST", "requestId must be a valid arq_* identifier", 400);
  }
  await materializeExpiry(env, principal, spaceId, requestId, agentId);
  const row = await env.DB.prepare(`SELECT * FROM authorization_requests
    WHERE id=? AND source_space_id=? AND application_id=? AND requesting_agent_id=? LIMIT 1`)
    .bind(requestId, spaceId, principal.clientId, agentId)
    .first<AuthorizationRequestRow>();
  if (!row) throw new ApiError("AUTHORIZATION_REQUEST_NOT_FOUND", "Authorization Request not found", 404);
  return row;
}

function requirePending(row: AuthorizationRequestRow): void {
  if (row.status !== "pending") {
    throw new ApiError(
      "AUTHORIZATION_REQUEST_NOT_PENDING",
      `Authorization Request is ${row.status}`,
      409,
    );
  }
}

async function verifyReviewToken(env: Bindings, requestId: string, reviewToken: string): Promise<void> {
  const tokenHash = await sha256(reviewToken);
  const row = await env.DB.prepare(`SELECT request_id FROM authorization_request_review_tokens
    WHERE request_id=? AND token_hash=? LIMIT 1`)
    .bind(requestId, tokenHash)
    .first<{ request_id: string }>();
  if (!row) throw new ApiError("AUTHORIZATION_REVIEW_INVALID", "Authorization Review token is invalid", 403);
}

function syntheticUserPrincipal(caller: Principal, row: AuthorizationRequestRow): Principal {
  return {
    type: "user",
    id: row.principal_user_id,
    clientId: row.application_id,
    scopes: [...caller.scopes],
    tokenId: caller.tokenId,
  };
}

async function createAuthorizationRequest(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  agentId: string,
  body: ReturnType<typeof parseCreateBody>,
) {
  const createdAt = now();
  const requestExpiresAt = new Date(
    Date.parse(createdAt) + body.requestTtlMinutes * 60_000,
  ).toISOString();
  const generatedRequestId = id("arq");
  const reviewToken = id("arv");
  const reviewTokenHash = await sha256(reviewToken);
  const dedupeItems = [...body.items].sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  const dedupeKey = await sha256(stableJson({
    applicationId: principal.clientId,
    agentId,
    principalUserId: body.principalUserId,
    spaceId,
    items: dedupeItems,
  }));
  const itemsJson = stableJson(body.items);
  const correlationJson = body.correlation ? stableJson(body.correlation) : null;

  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE authorization_requests
      SET status='expired',decided_at=COALESCE(decided_at,?)
      WHERE dedupe_key=? AND status='pending' AND request_expires_at<=?`)
      .bind(createdAt, dedupeKey, createdAt),
    env.DB.prepare(`INSERT OR IGNORE INTO authorization_requests(
      id,source_space_id,application_id,requesting_agent_id,principal_user_id,status,dedupe_key,
      requested_items_json,item_count,correlation_json,request_expires_at,created_at,decided_at
    ) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?,NULL)`)
      .bind(
        generatedRequestId,
        spaceId,
        principal.clientId,
        agentId,
        body.principalUserId,
        dedupeKey,
        itemsJson,
        body.items.length,
        correlationJson,
        requestExpiresAt,
        createdAt,
      ),
    env.DB.prepare(`SELECT * FROM authorization_requests
      WHERE dedupe_key=? AND status='pending' LIMIT 1`).bind(dedupeKey),
    env.DB.prepare(`INSERT INTO authorization_request_review_tokens(token_hash,request_id,created_at)
      SELECT ?,id,? FROM authorization_requests
      WHERE dedupe_key=? AND status='pending' LIMIT 1`)
      .bind(reviewTokenHash, createdAt, dedupeKey),
  ]);

  const rows = (results[2]?.results ?? []) as AuthorizationRequestRow[];
  const row = rows[0];
  if (!row) throw new Error("Authorization Request create/reuse did not produce a pending row");
  return {
    ...requestDto(row),
    reviewToken,
    reused: row.id !== generatedRequestId,
  };
}

async function transitionDecision(
  env: Bindings,
  row: AuthorizationRequestRow,
  status: "denied" | "cancelled",
): Promise<AuthorizationRequestRow> {
  const decidedAt = now();
  const result = await env.DB.prepare(`UPDATE authorization_requests SET status=?,decided_at=?
    WHERE id=? AND status='pending'`)
    .bind(status, decidedAt, row.id)
    .run();
  if (!result.meta.changes) {
    throw new ApiError("AUTHORIZATION_REQUEST_NOT_PENDING", "Authorization Request is no longer pending", 409);
  }
  return { ...row, status, decided_at: decidedAt };
}

export function registerAuthorizationRequestRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/authorization-requests", async (context) => {
    const principal = context.get("principal");
    const agentId = requireRequestingAgent(principal);
    const body = parseCreateBody(await context.req.json<unknown>().catch(() => null), agentId);
    const created = await createAuthorizationRequest(
      context.env,
      principal,
      context.req.param("spaceId"),
      agentId,
      body,
    );
    return context.json(success(created), 201);
  });

  app.get("/api/v1/spaces/:spaceId/authorization-requests/:requestId", async (context) => {
    const principal = context.get("principal");
    const agentId = requireRequestingAgent(principal);
    const row = await loadOwnedRequest(
      context.env,
      principal,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      agentId,
    );
    return context.json(success(requestDto(row)));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/confirm", async (context) => {
    const principal = context.get("principal");
    const agentId = requireRequestingAgent(principal);
    const body = parseReviewBody(await context.req.json<unknown>().catch(() => null));
    const row = await loadOwnedRequest(
      context.env,
      principal,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      agentId,
    );
    requirePending(row);
    await verifyReviewToken(context.env, row.id, body.reviewToken);

    const canonicalConfirmation = confirmationProjection(row);
    if (body.confirmation !== undefined
        && stableJson(body.confirmation) !== stableJson(canonicalConfirmation)) {
      throw new ApiError(
        "AUTHORIZATION_CONFIRMATION_MISMATCH",
        "Submitted confirmation does not match the canonical Authorization Request",
        409,
      );
    }

    const items = requestedItems(row);
    const userPrincipal = syntheticUserPrincipal(principal, row);
    const prepared = await prepareDelegationIssues(
      context.env,
      userPrincipal,
      row.source_space_id,
      items.map((item) => ({
        actor: { type: "agent", id: row.requesting_agent_id },
        scope: item.scope,
        constraints: item.constraints,
      })),
    );
    const decidedAt = now();
    await context.env.DB.batch([
      ...delegationIssueStatements(context.env, userPrincipal, row.source_space_id, prepared),
      ...prepared.map((issue, index) => context.env.DB.prepare(`INSERT INTO authorization_request_delegations(
        request_id,item_index,delegation_id
      ) VALUES(?,?,?)`).bind(row.id, index, issue.delegationId)),
      context.env.DB.prepare(`UPDATE authorization_requests SET status='approved',decided_at=?
        WHERE id=? AND status='pending'`).bind(decidedAt, row.id),
    ]);

    const approved = { ...row, status: "approved" as const, decided_at: decidedAt };
    return context.json(success({
      request: requestDto(approved),
      delegations: delegationIssueDtos(userPrincipal, row.source_space_id, prepared),
    }));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/deny", async (context) => {
    const principal = context.get("principal");
    const agentId = requireRequestingAgent(principal);
    const body = parseReviewBody(await context.req.json<unknown>().catch(() => null));
    const row = await loadOwnedRequest(
      context.env,
      principal,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      agentId,
    );
    requirePending(row);
    await verifyReviewToken(context.env, row.id, body.reviewToken);
    const denied = await transitionDecision(context.env, row, "denied");
    return context.json(success(requestDto(denied)));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/cancel", async (context) => {
    const principal = context.get("principal");
    const agentId = requireRequestingAgent(principal);
    const raw = await context.req.json<unknown>().catch(() => ({}));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length) {
      throw new ApiError("INVALID_REQUEST", "Cancel request body must be an empty JSON object", 400);
    }
    const row = await loadOwnedRequest(
      context.env,
      principal,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      agentId,
    );
    requirePending(row);
    const cancelled = await transitionDecision(context.env, row, "cancelled");
    return context.json(success(requestDto(cancelled)));
  });
}

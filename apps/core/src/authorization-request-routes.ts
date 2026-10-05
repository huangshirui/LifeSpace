import type { Hono } from "hono";
import {
  delegationIssueDtos,
  delegationIssueStatements,
  loadDelegationDtosByIds,
  parseAuthorizationRequestItem,
  prepareDelegationIssues,
  type ParsedConstraints,
  type ParsedScope,
} from "./delegation-routes";
import type { Actor, Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type RequestStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";

type CreateBody = {
  principalUserId?: unknown;
  items?: unknown;
  requestTtlMinutes?: unknown;
  correlation?: unknown;
};
type ConfirmBody = { principalUserId?: unknown; confirmation?: unknown };
type DenyBody = { principalUserId?: unknown };
type Correlation = { sessionId?: string; conversationId?: string };
type CanonicalItem = { scope: ParsedScope; constraints: ParsedConstraints };
type RequestRow = {
  id: string;
  application_id: string;
  requesting_agent_id: string;
  intended_user_id: string;
  source_space_id: string;
  request_ttl_minutes: number;
  fingerprint: string;
  reuse_key: string;
  correlation_json: string | null;
  created_at: string;
  expires_at: string;
  transition_status: "approved" | "denied" | "cancelled" | null;
  transitioned_at: string | null;
};
type ItemRow = {
  ordinal: number;
  target_type: ParsedScope["target"]["type"];
  target_id: string;
  max_access: ParsedScope["maxAccess"];
  max_uses: 1 | null;
  delegation_expires_at: string | null;
  remaining_redelegation_depth: number;
};

const MAX_ITEMS = 20;
const DEFAULT_TTL_MINUTES = 60;
const MAX_TTL_MINUTES = 1440;
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function requestingAgent(principal: Principal): Actor {
  const actor = principal.actor ?? { type: principal.type, id: principal.id };
  if (principal.type !== "agent" || actor.type !== "agent" || principal.id !== actor.id) {
    throw new ApiError("FORBIDDEN", "Authorization Request requires direct Agent execution", 403);
  }
  if (principal.purpose !== "agent_api" && principal.purpose !== "agent_execution") {
    throw new ApiError("FORBIDDEN", "Authorization Request requires verified Agent execution context", 403);
  }
  return actor;
}

function principalUserId(value: unknown): string {
  if (typeof value !== "string" || !/^usr_[A-Za-z0-9_-]+$/u.test(value.trim())) {
    throw new ApiError("INVALID_REQUEST", "principalUserId must be a valid usr_* identifier", 400);
  }
  return value.trim();
}

function assertIntendedUser(row: RequestRow, value: unknown): string {
  const currentUserId = principalUserId(value);
  if (currentUserId !== row.intended_user_id) {
    throw new ApiError(
      "AUTHORIZATION_REQUEST_PRINCIPAL_MISMATCH",
      "Trusted workflow User does not match the Authorization Request Principal",
      403,
    );
  }
  return currentUserId;
}

function requestTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_TTL_MINUTES) {
    throw new ApiError(
      "INVALID_REQUEST",
      `requestTtlMinutes must be an integer between 1 and ${MAX_TTL_MINUTES}`,
      400,
    );
  }
  return Number(value);
}

function correlation(value: unknown): Correlation | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "correlation must be an object", 400);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !["sessionId", "conversationId"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported correlation field ${unknown}`, 400);
  const result: Correlation = {};
  for (const key of ["sessionId", "conversationId"] as const) {
    const entry = input[key];
    if (entry === undefined) continue;
    if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 200) {
      throw new ApiError("INVALID_REQUEST", `correlation.${key} must contain 1-200 characters`, 400);
    }
    result[key] = entry.trim();
  }
  return result;
}

function canonicalConstraints(value: ParsedConstraints) {
  return {
    ...(value.maxUses === 1 ? { maxUses: 1 as const } : {}),
    ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
    remainingRedelegationDepth: value.remainingRedelegationDepth,
  };
}

function canonicalItem(value: CanonicalItem) {
  return { scope: value.scope, constraints: canonicalConstraints(value.constraints) };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseItems(actor: Actor, value: unknown, spaceId: string): CanonicalItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ITEMS) {
    throw new ApiError("INVALID_REQUEST", `items must contain between 1 and ${MAX_ITEMS} entries`, 400);
  }
  return value.map((entry) => {
    const parsed = parseAuthorizationRequestItem(actor, entry);
    if (parsed.scope.target.type === "space" && parsed.scope.target.id !== spaceId) {
      throw new ApiError("INVALID_REQUEST", "Space scope target must equal the route Space", 400);
    }
    return parsed;
  });
}

function status(row: RequestRow): RequestStatus {
  if (row.transition_status) return row.transition_status;
  return Date.parse(row.expires_at) <= Date.now() ? "expired" : "pending";
}

function itemFromRow(row: ItemRow): CanonicalItem {
  return {
    scope: { target: { type: row.target_type, id: row.target_id }, maxAccess: row.max_access },
    constraints: {
      maxUses: row.max_uses,
      expiresAt: row.delegation_expires_at,
      remainingRedelegationDepth: row.remaining_redelegation_depth,
    },
  };
}

async function loadRequest(env: Bindings, spaceId: string, requestId: string): Promise<{ row: RequestRow; items: CanonicalItem[] } | null> {
  const row = await env.DB.prepare(`SELECT
      r.id,r.application_id,r.requesting_agent_id,r.intended_user_id,r.source_space_id,
      r.request_ttl_minutes,r.fingerprint,r.reuse_key,r.correlation_json,r.created_at,r.expires_at,
      t.status AS transition_status,t.transitioned_at
    FROM authorization_requests r
    LEFT JOIN authorization_request_transitions t ON t.request_id=r.id
    WHERE r.id=? AND r.source_space_id=? LIMIT 1`)
    .bind(requestId, spaceId).first<RequestRow>();
  if (!row) return null;
  const itemRows = await env.DB.prepare(`SELECT
      ordinal,target_type,target_id,max_access,max_uses,delegation_expires_at,remaining_redelegation_depth
    FROM authorization_request_items WHERE request_id=? ORDER BY ordinal`)
    .bind(requestId).all<ItemRow>();
  return { row, items: itemRows.results.map(itemFromRow) };
}

function assertOwned(principal: Principal, actor: Actor, loaded: { row: RequestRow; items: CanonicalItem[] } | null) {
  if (!loaded
      || loaded.row.application_id !== principal.clientId
      || loaded.row.requesting_agent_id !== actor.id) {
    throw new ApiError("AUTHORIZATION_REQUEST_NOT_FOUND", "Authorization Request not found", 404);
  }
  return loaded;
}

function confirmation(row: RequestRow, items: CanonicalItem[]) {
  return {
    requestId: row.id,
    principal: { type: "user" as const, id: row.intended_user_id },
    actor: { type: "agent" as const, id: row.requesting_agent_id },
    applicationId: row.application_id,
    spaceId: row.source_space_id,
    items: items.map(canonicalItem),
    requestExpiresAt: row.expires_at,
  };
}

function requestDto(row: RequestRow, items: CanonicalItem[], extra: Record<string, unknown> = {}) {
  const parsedCorrelation = row.correlation_json ? JSON.parse(row.correlation_json) as Correlation : null;
  return {
    id: row.id,
    status: status(row),
    principal: { type: "user" as const, id: row.intended_user_id },
    actor: { type: "agent" as const, id: row.requesting_agent_id },
    applicationId: row.application_id,
    spaceId: row.source_space_id,
    items: items.map(canonicalItem),
    requestTtlMinutes: row.request_ttl_minutes,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    transitionedAt: row.transitioned_at,
    correlation: parsedCorrelation,
    confirmation: confirmation(row, items),
    ...extra,
  };
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  );
}

function confirmationMatches(expected: unknown, submitted: unknown): boolean {
  return JSON.stringify(normalizeJson(expected)) === JSON.stringify(normalizeJson(submitted));
}

async function loadApprovedDelegations(env: Bindings, requestId: string) {
  const rows = await env.DB.prepare(`SELECT delegation_id
    FROM authorization_request_delegations WHERE request_id=? ORDER BY ordinal`)
    .bind(requestId).all<{ delegation_id: string }>();
  return loadDelegationDtosByIds(env, rows.results.map((row) => row.delegation_id));
}

async function afterTransitionConflict(env: Bindings, principal: Principal, actor: Actor, spaceId: string, requestId: string) {
  const current = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));
  const currentStatus = status(current.row);
  if (currentStatus === "approved") {
    return { current, delegations: await loadApprovedDelegations(env, requestId) };
  }
  throw new ApiError(
    currentStatus === "expired" ? "AUTHORIZATION_REQUEST_EXPIRED" : "AUTHORIZATION_REQUEST_NOT_PENDING",
    `Authorization Request is ${currentStatus}`,
    409,
  );
}

async function terminalTransition(
  env: Bindings,
  principal: Principal,
  actor: Actor,
  spaceId: string,
  requestId: string,
  target: "denied" | "cancelled",
  currentUserId?: string,
) {
  const loaded = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));
  if (target === "denied") {
    assertIntendedUser(loaded.row, currentUserId);
  }
  const current = status(loaded.row);
  if (current === target) return loaded;
  if (current !== "pending") {
    throw new ApiError(
      current === "expired" ? "AUTHORIZATION_REQUEST_EXPIRED" : "AUTHORIZATION_REQUEST_NOT_PENDING",
      `Authorization Request is ${current}`,
      409,
    );
  }
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO authorization_request_transitions(
        request_id,status,transitioned_at,actor_type,actor_id
      ) VALUES(?,?,?,?,?)`).bind(requestId, target, now, actor.type, actor.id),
      env.DB.prepare("DELETE FROM authorization_request_reuse_keys WHERE reuse_key=? AND request_id=?")
        .bind(loaded.row.reuse_key, requestId),
    ]);
  } catch (error) {
    const refreshed = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));
    const refreshedStatus = status(refreshed.row);
    if (refreshedStatus === target) return refreshed;
    if (refreshedStatus !== "pending") {
      await afterTransitionConflict(env, principal, actor, spaceId, requestId);
    }
    throw error;
  }
  return assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));
}

export function registerAuthorizationRequestRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/authorization-requests", async (context) => {
    const principal = context.get("principal");
    const actor = requestingAgent(principal);
    const spaceId = context.req.param("spaceId");
    const body = await context.req.json<CreateBody>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
    }
    const unknown = Object.keys(body).find((key) => !["principalUserId", "items", "requestTtlMinutes", "correlation"].includes(key));
    if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported Authorization Request field ${unknown}`, 400);

    const intendedUserId = principalUserId(body.principalUserId);
    const items = parseItems(actor, body.items, spaceId);
    const ttl = requestTtl(body.requestTtlMinutes);
    const requestCorrelation = correlation(body.correlation);
    const fingerprint = await sha256({ ttl, items: items.map(canonicalItem) });
    const reuseKey = await sha256({
      applicationId: principal.clientId,
      agentId: actor.id,
      intendedUserId,
      spaceId,
      fingerprint,
    });

    const existingKey = await context.env.DB.prepare(
      "SELECT request_id FROM authorization_request_reuse_keys WHERE reuse_key=? LIMIT 1",
    ).bind(reuseKey).first<{ request_id: string }>();
    let staleRequestId: string | null = null;
    if (existingKey) {
      const existing = assertOwned(principal, actor, await loadRequest(context.env, spaceId, existingKey.request_id));
      if (status(existing.row) === "pending") {
        return context.json(success(requestDto(existing.row, existing.items, { reused: true })), 200);
      }
      staleRequestId = existing.row.id;
    }

    const requestId = id("arq");
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttl * 60_000).toISOString();
    const statements: D1PreparedStatement[] = [];
    if (staleRequestId) {
      statements.push(context.env.DB.prepare(
        "DELETE FROM authorization_request_reuse_keys WHERE reuse_key=? AND request_id=?",
      ).bind(reuseKey, staleRequestId));
    }
    statements.push(
      context.env.DB.prepare(`INSERT INTO authorization_requests(
        id,application_id,requesting_agent_id,intended_user_id,source_space_id,
        request_ttl_minutes,fingerprint,reuse_key,correlation_json,created_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
        requestId,
        principal.clientId,
        actor.id,
        intendedUserId,
        spaceId,
        ttl,
        fingerprint,
        reuseKey,
        requestCorrelation ? JSON.stringify(requestCorrelation) : null,
        createdAt.toISOString(),
        expiresAt,
      ),
      ...items.map((item, ordinal) => context.env.DB.prepare(`INSERT INTO authorization_request_items(
        request_id,ordinal,target_type,target_id,max_access,max_uses,delegation_expires_at,remaining_redelegation_depth
      ) VALUES(?,?,?,?,?,?,?,?)`).bind(
        requestId,
        ordinal,
        item.scope.target.type,
        item.scope.target.id,
        item.scope.maxAccess,
        item.constraints.maxUses,
        item.constraints.expiresAt,
        item.constraints.remainingRedelegationDepth,
      )),
      context.env.DB.prepare(
        "INSERT INTO authorization_request_reuse_keys(reuse_key,request_id) VALUES(?,?)",
      ).bind(reuseKey, requestId),
    );

    try {
      await context.env.DB.batch(statements);
    } catch (error) {
      const winner = await context.env.DB.prepare(
        "SELECT request_id FROM authorization_request_reuse_keys WHERE reuse_key=? LIMIT 1",
      ).bind(reuseKey).first<{ request_id: string }>();
      if (winner) {
        const existing = assertOwned(principal, actor, await loadRequest(context.env, spaceId, winner.request_id));
        if (status(existing.row) === "pending") {
          return context.json(success(requestDto(existing.row, existing.items, { reused: true })), 200);
        }
      }
      throw error;
    }

    const created = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));
    return context.json(success(requestDto(created.row, created.items, { reused: false })), 201);
  });

  app.get("/api/v1/spaces/:spaceId/authorization-requests/:requestId", async (context) => {
    const principal = context.get("principal");
    const actor = requestingAgent(principal);
    const loaded = assertOwned(
      principal,
      actor,
      await loadRequest(context.env, context.req.param("spaceId"), context.req.param("requestId")),
    );
    const delegations = status(loaded.row) === "approved"
      ? await loadApprovedDelegations(context.env, loaded.row.id)
      : [];
    return context.json(success(requestDto(loaded.row, loaded.items, { delegations })));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/confirm", async (context) => {
    const principal = context.get("principal");
    const actor = requestingAgent(principal);
    const spaceId = context.req.param("spaceId");
    const requestId = context.req.param("requestId");
    const rawBody = await context.req.json<unknown>().catch(() => null);
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)
        || Object.keys(rawBody).some((key) => !["principalUserId", "confirmation"].includes(key))) {
      throw new ApiError(
        "INVALID_REQUEST",
        "Confirm body requires trusted principalUserId and accepts optional confirmation",
        400,
      );
    }
    const body = rawBody as ConfirmBody;

    const loaded = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));
    assertIntendedUser(loaded.row, body.principalUserId);
    const current = status(loaded.row);
    if (current === "approved") {
      return context.json(success(requestDto(loaded.row, loaded.items, {
        delegations: await loadApprovedDelegations(context.env, requestId),
      })));
    }
    if (current !== "pending") {
      throw new ApiError(
        current === "expired" ? "AUTHORIZATION_REQUEST_EXPIRED" : "AUTHORIZATION_REQUEST_NOT_PENDING",
        `Authorization Request is ${current}`,
        409,
      );
    }

    const expectedConfirmation = confirmation(loaded.row, loaded.items);
    if (body.confirmation !== undefined && !confirmationMatches(expectedConfirmation, body.confirmation)) {
      throw new ApiError("CONFIRMATION_MISMATCH", "Submitted confirmation does not match the canonical Authorization Request", 409);
    }

    // This synthetic direct User Principal is not authentication. It is a bounded
    // authorization-evaluation context sourced from the immutable arq_* request.
    // Current Agent credential scopes, Application × Model Access and the User's
    // current Space/model Authority are all rechecked by the #298 preparation path.
    const rootPrincipal: Principal = {
      type: "user",
      id: loaded.row.intended_user_id,
      clientId: principal.clientId,
      scopes: principal.scopes,
      tokenId: principal.tokenId,
    };
    const issueValues = loaded.items.map((item) => ({
      actor: { type: "agent", id: actor.id },
      scope: item.scope,
      constraints: canonicalConstraints(item.constraints),
    }));
    const prepared = await prepareDelegationIssues(
      context.env,
      rootPrincipal,
      spaceId,
      issueValues,
      actor,
    );
    const now = new Date().toISOString();
    const issueStatements = delegationIssueStatements(context.env, rootPrincipal, spaceId, prepared);
    const resultStatements = prepared.map((issue, ordinal) => context.env.DB.prepare(`INSERT INTO authorization_request_delegations(
      request_id,ordinal,delegation_id
    ) VALUES(?,?,?)`).bind(requestId, ordinal, issue.delegationId));

    try {
      await context.env.DB.batch([
        context.env.DB.prepare(`INSERT INTO authorization_request_transitions(
          request_id,status,transitioned_at,actor_type,actor_id
        ) VALUES(?,'approved',?,?,?)`).bind(requestId, now, actor.type, actor.id),
        context.env.DB.prepare("DELETE FROM authorization_request_reuse_keys WHERE reuse_key=? AND request_id=?")
          .bind(loaded.row.reuse_key, requestId),
        ...issueStatements,
        ...resultStatements,
      ]);
    } catch (error) {
      const refreshed = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));
      if (status(refreshed.row) === "approved") {
        return context.json(success(requestDto(refreshed.row, refreshed.items, {
          delegations: await loadApprovedDelegations(context.env, requestId),
        })));
      }
      if (status(refreshed.row) !== "pending") {
        await afterTransitionConflict(context.env, principal, actor, spaceId, requestId);
      }
      throw error;
    }

    const approved = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));
    return context.json(success(requestDto(approved.row, approved.items, {
      delegations: delegationIssueDtos(rootPrincipal, spaceId, prepared),
    })));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/deny", async (context) => {
    const principal = context.get("principal");
    const actor = requestingAgent(principal);
    const rawBody = await context.req.json<unknown>().catch(() => null);
    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)
        || Object.keys(rawBody).some((key) => key !== "principalUserId")) {
      throw new ApiError("INVALID_REQUEST", "Deny body requires only trusted principalUserId", 400);
    }
    const body = rawBody as DenyBody;
    const currentUserId = principalUserId(body.principalUserId);
    const loaded = await terminalTransition(
      context.env,
      principal,
      actor,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      "denied",
      currentUserId,
    );
    return context.json(success(requestDto(loaded.row, loaded.items)));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/cancel", async (context) => {
    const principal = context.get("principal");
    const actor = requestingAgent(principal);
    const loaded = await terminalTransition(
      context.env,
      principal,
      actor,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      "cancelled",
    );
    return context.json(success(requestDto(loaded.row, loaded.items)));
  });
}

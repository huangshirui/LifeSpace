from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def replace_exact(path: str, old: str, new: str):
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}")
    p.write_text(text.replace(old, new, 1))


# Extend the #298 primitive so #306 Confirm can prepare and atomically commit
# the same Delegation representation together with the Authorization Request transition.
path = ROOT / "apps/core/src/delegation-routes.ts"
text = path.read_text()
text = text.replace("type PreparedDelegationIssue = ParsedDelegationIssue & {", "export type PreparedDelegationIssue = ParsedDelegationIssue & {")
text = text.replace("type ParsedScope = {", "export type ParsedScope = {")
text = text.replace("type ParsedConstraints = {", "export type ParsedConstraints = {")

anchor = '''function parseCreateDelegationBody(value: unknown): ParsedDelegationIssue {\n'''
if text.count(anchor) != 1:
    raise SystemExit("delegation-routes.ts: parseCreateDelegationBody anchor missing")
insert = '''export function parseAuthorizationRequestItem(\n  actor: Actor,\n  value: unknown,\n): { scope: ParsedScope; constraints: ParsedConstraints } {\n  if (!value || typeof value !== "object" || Array.isArray(value)) {\n    throw new ApiError("INVALID_REQUEST", "Authorization Request item must be a JSON object", 400);\n  }\n  const input = value as Record<string, unknown>;\n  const unknown = Object.keys(input).find((key) => !["scope", "constraints"].includes(key));\n  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported Authorization Request item field ${unknown}`, 400);\n  const parsed = parseCreateDelegationBody({ actor, scope: input.scope, constraints: input.constraints });\n  return { scope: parsed.scope, constraints: parsed.constraints };\n}\n\n'''
# Insert after parseCreateDelegationBody definition, immediately before assertIssuanceProfile.
needle = '''function assertIssuanceProfile(principal: Principal, issue: ParsedDelegationIssue): void {'''
if text.count(needle) != 1:
    raise SystemExit("delegation-routes.ts: assertIssuanceProfile anchor missing")
text = text.replace(needle, insert + needle, 1)

old_prepare = '''async function prepareDelegationIssues(\n  env: Bindings,\n  principal: Principal,\n  spaceId: string,\n  values: readonly unknown[],\n): Promise<PreparedDelegationIssue[]> {'''
new_prepare = '''export async function prepareDelegationIssues(\n  env: Bindings,\n  principal: Principal,\n  spaceId: string,\n  values: readonly unknown[],\n  issuerOverride?: Actor,\n): Promise<PreparedDelegationIssue[]> {'''
if text.count(old_prepare) != 1:
    raise SystemExit("delegation-routes.ts: prepare signature drifted")
text = text.replace(old_prepare, new_prepare, 1)
text = text.replace('''  const issuer = executionActor(principal);\n''', '''  const issuer = issuerOverride ?? executionActor(principal);\n''', 1)

old_commit = '''async function commitDelegationIssues(\n  env: Bindings,\n  principal: Principal,\n  spaceId: string,\n  issues: readonly PreparedDelegationIssue[],\n): Promise<ReturnType<typeof dto>[]> {\n  const statements = issues.flatMap((issue) => [\n    env.DB.prepare(`INSERT INTO delegations(\n      id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,\n      created_by_type,created_by_id,created_at,expires_at,max_uses,\n      parent_delegation_id,remaining_redelegation_depth\n    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(\n      issue.delegationId,\n      principal.type,\n      principal.id,\n      issue.actor.type,\n      issue.actor.id,\n      principal.clientId,\n      spaceId,\n      issue.issuer.type,\n      issue.issuer.id,\n      issue.createdAt,\n      issue.constraints.expiresAt,\n      issue.constraints.maxUses,\n      issue.parent?.delegation_id ?? null,\n      issue.constraints.remainingRedelegationDepth,\n    ),\n    env.DB.prepare(`INSERT INTO delegation_scopes(\n      delegation_id,target_type,target_id,target_model_key,max_access\n    ) VALUES(?,?,?,?,?)`).bind(\n      issue.delegationId,\n      issue.scope.target.type,\n      issue.scope.target.id,\n      issue.targetModelKey,\n      issue.scope.maxAccess,\n    ),\n  ]);\n\n  // Cloudflare D1 batch is the atomic commit boundary: all Delegation/scopes are\n  // persisted together, or the batch rolls back. Child issuance intentionally\n  // does not consume any single-use ancestor.\n  await env.DB.batch(statements);\n\n  return issues.map((issue) => dto({\n    id: issue.delegationId,\n    principal_type: principal.type,\n    principal_id: principal.id,\n    actor_type: issue.actor.type,\n    actor_id: issue.actor.id,\n    application_id: principal.clientId,\n    source_space_id: spaceId,\n    parent_delegation_id: issue.parent?.delegation_id ?? null,\n    remaining_redelegation_depth: issue.constraints.remainingRedelegationDepth,\n    created_by_type: issue.issuer.type,\n    created_by_id: issue.issuer.id,\n    created_at: issue.createdAt,\n    expires_at: issue.constraints.expiresAt,\n    revoked_at: null,\n    max_uses: issue.constraints.maxUses,\n    consumed_at: null,\n    target_type: issue.scope.target.type,\n    target_id: issue.scope.target.id,\n    target_model_key: issue.targetModelKey,\n    max_access: issue.scope.maxAccess,\n  }));\n}\n'''
new_commit = '''export function delegationIssueStatements(\n  env: Bindings,\n  principal: Principal,\n  spaceId: string,\n  issues: readonly PreparedDelegationIssue[],\n): D1PreparedStatement[] {\n  return issues.flatMap((issue) => [\n    env.DB.prepare(`INSERT INTO delegations(\n      id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,\n      created_by_type,created_by_id,created_at,expires_at,max_uses,\n      parent_delegation_id,remaining_redelegation_depth\n    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(\n      issue.delegationId,\n      principal.type,\n      principal.id,\n      issue.actor.type,\n      issue.actor.id,\n      principal.clientId,\n      spaceId,\n      issue.issuer.type,\n      issue.issuer.id,\n      issue.createdAt,\n      issue.constraints.expiresAt,\n      issue.constraints.maxUses,\n      issue.parent?.delegation_id ?? null,\n      issue.constraints.remainingRedelegationDepth,\n    ),\n    env.DB.prepare(`INSERT INTO delegation_scopes(\n      delegation_id,target_type,target_id,target_model_key,max_access\n    ) VALUES(?,?,?,?,?)`).bind(\n      issue.delegationId,\n      issue.scope.target.type,\n      issue.scope.target.id,\n      issue.targetModelKey,\n      issue.scope.maxAccess,\n    ),\n  ]);\n}\n\nexport function delegationIssueDtos(\n  principal: Principal,\n  spaceId: string,\n  issues: readonly PreparedDelegationIssue[],\n): ReturnType<typeof dto>[] {\n  return issues.map((issue) => dto({\n    id: issue.delegationId,\n    principal_type: principal.type,\n    principal_id: principal.id,\n    actor_type: issue.actor.type,\n    actor_id: issue.actor.id,\n    application_id: principal.clientId,\n    source_space_id: spaceId,\n    parent_delegation_id: issue.parent?.delegation_id ?? null,\n    remaining_redelegation_depth: issue.constraints.remainingRedelegationDepth,\n    created_by_type: issue.issuer.type,\n    created_by_id: issue.issuer.id,\n    created_at: issue.createdAt,\n    expires_at: issue.constraints.expiresAt,\n    revoked_at: null,\n    max_uses: issue.constraints.maxUses,\n    consumed_at: null,\n    target_type: issue.scope.target.type,\n    target_id: issue.scope.target.id,\n    target_model_key: issue.targetModelKey,\n    max_access: issue.scope.maxAccess,\n  }));\n}\n\nasync function commitDelegationIssues(\n  env: Bindings,\n  principal: Principal,\n  spaceId: string,\n  issues: readonly PreparedDelegationIssue[],\n): Promise<ReturnType<typeof dto>[]> {\n  // Cloudflare D1 batch is the atomic commit boundary: all Delegation/scopes are\n  // persisted together, or the batch rolls back. Child issuance intentionally\n  // does not consume any single-use ancestor.\n  await env.DB.batch(delegationIssueStatements(env, principal, spaceId, issues));\n  return delegationIssueDtos(principal, spaceId, issues);\n}\n'''
if old_commit not in text:
    raise SystemExit("delegation-routes.ts: commit block drifted")
text = text.replace(old_commit, new_commit, 1)

select_anchor = '''function selectRowsSql(): string {\n'''
if text.count(select_anchor) != 1:
    raise SystemExit("delegation-routes.ts: selectRowsSql anchor missing")
# Export loader after selectRowsSql function by inserting before registerDelegationRoutes.
loader_anchor = '''export function registerDelegationRoutes(app: App): void {'''
loader = '''export async function loadDelegationDtosByIds(\n  env: Bindings,\n  delegationIds: readonly string[],\n): Promise<ReturnType<typeof dto>[]> {\n  if (!delegationIds.length) return [];\n  const placeholders = delegationIds.map(() => "?").join(",");\n  const rows = await env.DB.prepare(`${selectRowsSql()} WHERE d.id IN (${placeholders})`)\n    .bind(...delegationIds).all<DelegationRow>();\n  const byId = new Map(rows.results.map((row) => [row.id, dto(row)]));\n  return delegationIds.flatMap((delegationId) => {\n    const item = byId.get(delegationId);\n    return item ? [item] : [];\n  });\n}\n\n'''
if text.count(loader_anchor) != 1:
    raise SystemExit("delegation-routes.ts: register anchor missing")
text = text.replace(loader_anchor, loader + loader_anchor, 1)
path.write_text(text)


route_source = r'''import type { Hono } from "hono";
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
type ConfirmBody = { confirmation?: unknown };
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
) {
  const loaded = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));
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
  } catch {
    const refreshed = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));
    if (status(refreshed.row) === target) return refreshed;
    await afterTransitionConflict(env, principal, actor, spaceId, requestId);
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
    const body = await context.req.json<ConfirmBody>().catch(() => ({}));
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some((key) => key !== "confirmation")) {
      throw new ApiError("INVALID_REQUEST", "Confirm body accepts only optional confirmation", 400);
    }

    const loaded = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));
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
    } catch {
      const resolved = await afterTransitionConflict(context.env, principal, actor, spaceId, requestId);
      return context.json(success(requestDto(resolved.current.row, resolved.current.items, {
        delegations: resolved.delegations,
      })));
    }

    const approved = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));
    return context.json(success(requestDto(approved.row, approved.items, {
      delegations: delegationIssueDtos(rootPrincipal, spaceId, prepared),
    })));
  });

  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/deny", async (context) => {
    const principal = context.get("principal");
    const actor = requestingAgent(principal);
    const loaded = await terminalTransition(
      context.env,
      principal,
      actor,
      context.req.param("spaceId"),
      context.req.param("requestId"),
      "denied",
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
'''
(ROOT / "apps/core/src/authorization-request-routes.ts").write_text(route_source)

# App registration.
replace_exact(
    "apps/core/src/app.ts",
    'import { registerDelegationRoutes } from "./delegation-routes";\n',
    'import { registerDelegationRoutes } from "./delegation-routes";\nimport { registerAuthorizationRequestRoutes } from "./authorization-request-routes";\n',
)
replace_exact(
    "apps/core/src/app.ts",
    '  registerDelegationRoutes(app);\n',
    '  registerDelegationRoutes(app);\n  registerAuthorizationRequestRoutes(app);\n',
)

# Kernel contract bump.
replace_exact(
    "apps/core/src/kernel-contract.ts",
    'export const CORE_KERNEL_CONTRACT_VERSION = "0.44.0" as const;',
    'export const CORE_KERNEL_CONTRACT_VERSION = "0.45.0" as const;',
)

# Keep the nested engineering source of truth aligned.
replace_exact(
    "apps/core/AGENTS.md",
    'current Kernel version: 0.44.0',
    'current Kernel version: 0.45.0',
)

# Migration: add reusable-key uniqueness and an expiry-at-commit trigger.
migration = ROOT / "apps/core/migrations/0049_authorization_requests.sql"
mig = migration.read_text()
needle = "CREATE TABLE authorization_request_items (\n"
if mig.count(needle) != 1:
    raise SystemExit("0049 migration item anchor missing")
reuse = '''CREATE TABLE authorization_request_reuse_keys (\n  reuse_key TEXT PRIMARY KEY,\n  request_id TEXT NOT NULL UNIQUE REFERENCES authorization_requests(id) ON DELETE CASCADE\n);\n\n'''
mig = mig.replace(needle, reuse + needle, 1)
trigger_anchor = "CREATE TABLE authorization_request_delegations (\n"
if mig.count(trigger_anchor) != 1:
    raise SystemExit("0049 migration delegation anchor missing")
trigger = '''CREATE TRIGGER trg_authorization_request_transition_not_expired\nBEFORE INSERT ON authorization_request_transitions\nBEGIN\n  SELECT (CASE\n    WHEN NOT EXISTS(\n      SELECT 1 FROM authorization_requests r\n      WHERE r.id=NEW.request_id AND julianday(r.expires_at)>julianday('now')\n    )\n    THEN RAISE(ABORT, 'AUTHORIZATION_REQUEST_EXPIRED')\n  END);\nEND;\n\n'''
mig = mig.replace(trigger_anchor, trigger + trigger_anchor, 1)
# reuse_key is persisted for exact cleanup and debugging while remaining non-secret.
mig = mig.replace(
    "  fingerprint TEXT NOT NULL,\n  correlation_json TEXT,",
    "  fingerprint TEXT NOT NULL,\n  reuse_key TEXT NOT NULL,\n  correlation_json TEXT,",
    1,
)
migration.write_text(mig)

# OpenAPI is JSON-compatible despite the .yaml extension; preserve insertion order and compact form.
openapi_path = ROOT / "apps/core/openapi.yaml"
doc = json.loads(openapi_path.read_text())
doc["info"]["version"] = "0.45.0"
doc["info"]["description"] = doc["info"]["description"].replace(
    "Kernel 0.43.0 adds bounded atomic multi-Delegation issuance while preserving one immutable scope per Delegation.",
    "Kernel 0.43.0 adds bounded atomic multi-Delegation issuance while preserving one immutable scope per Delegation. Kernel 0.45.0 adds durable arq_* Authorization Requests for transport-independent Agent-mediated user confirmation; request creation grants no Authority and Confirm rechecks current User/Application/credential Authority before atomically approving and issuing independent Delegations.",
)
if not any(tag.get("name") == "Authorization Requests" for tag in doc["tags"]):
    delegation_index = next(i for i, tag in enumerate(doc["tags"]) if tag.get("name") == "Delegations")
    doc["tags"].insert(delegation_index, {"name": "Authorization Requests"})

space_param = {"$ref": "#/components/parameters/SpaceId"}
request_param = {"name": "requestId", "in": "path", "required": True, "schema": {"type": "string", "pattern": "^arq_[A-Za-z0-9_-]+$"}}
error_responses = {
    "400": {"$ref": "#/components/responses/InvalidRequest"},
    "401": {"$ref": "#/components/responses/Unauthorized"},
    "403": {"$ref": "#/components/responses/Forbidden"},
    "404": {"$ref": "#/components/responses/NotFound"},
    "409": {"$ref": "#/components/responses/Conflict"},
}
doc["paths"]["/api/v1/spaces/{spaceId}/authorization-requests"] = {
    "parameters": [space_param],
    "post": {
        "tags": ["Authorization Requests"],
        "operationId": "createAuthorizationRequest",
        "description": "Creates or reuses one still-valid identical pending arq_* request for an authenticated Agent/Application and trusted server-side intended usr_* context. Creation grants no Authority. correlation is routing metadata only.",
        "requestBody": {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/CreateAuthorizationRequest"}}}},
        "responses": {
            "201": {"description": "Authorization Request created", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}},
            "200": {"description": "Existing identical pending Authorization Request reused", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}},
            **error_responses,
        },
    },
}
doc["paths"]["/api/v1/spaces/{spaceId}/authorization-requests/{requestId}"] = {
    "parameters": [space_param, request_param],
    "get": {
        "tags": ["Authorization Requests"],
        "operationId": "getAuthorizationRequest",
        "description": "Reads one Authorization Request owned by the same authenticated Agent/Application. expired is derived when no terminal transition exists and request TTL elapsed.",
        "responses": {
            "200": {"description": "Authorization Request", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}},
            "401": error_responses["401"], "403": error_responses["403"], "404": error_responses["404"],
        },
    },
}
doc["paths"]["/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/confirm"] = {
    "parameters": [space_param, request_param],
    "post": {
        "tags": ["Authorization Requests"],
        "operationId": "confirmAuthorizationRequest",
        "description": "Confirms one pending request through the same authenticated Agent/Application. Optional confirmation must be structurally equal to the canonical projection. Core rechecks the intended User's current Authority and atomically records approval plus 1..20 independent Delegations using the same issuance primitive as /delegations/batch. Repeated approved confirmation is idempotent.",
        "requestBody": {"required": False, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ConfirmAuthorizationRequest"}}}},
        "responses": {
            "200": {"description": "Authorization Request approved and Delegations returned", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}},
            **error_responses,
        },
    },
}
for action, operation_id, description in [
    ("deny", "denyAuthorizationRequest", "Records explicit User rejection through the trusted presentation workflow. Agent/Application ownership is rechecked; no Delegation is issued."),
    ("cancel", "cancelAuthorizationRequest", "Cancels the requesting Agent/Application's own pending request. Cancellation is distinct from User denial and issues no Delegation."),
]:
    doc["paths"][f"/api/v1/spaces/{{spaceId}}/authorization-requests/{{requestId}}/{action}"] = {
        "parameters": [space_param, request_param],
        "post": {
            "tags": ["Authorization Requests"],
            "operationId": operation_id,
            "description": description,
            "responses": {
                "200": {"description": f"Authorization Request {action}ed", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}},
                **error_responses,
            },
        },
    }

schemas = doc["components"]["schemas"]
schemas["AuthorizationRequestItem"] = {
    "type": "object", "additionalProperties": False, "required": ["scope", "constraints"],
    "properties": {"scope": {"$ref": "#/components/schemas/DelegationScope"}, "constraints": {"$ref": "#/components/schemas/DelegationConstraints"}},
}
schemas["AuthorizationRequestCorrelation"] = {
    "type": "object", "additionalProperties": False,
    "properties": {"sessionId": {"type": "string", "minLength": 1, "maxLength": 200}, "conversationId": {"type": "string", "minLength": 1, "maxLength": 200}},
    "description": "Routing/correlation metadata only; never request identity or Authority proof.",
}
schemas["AuthorizationRequestConfirmation"] = {
    "type": "object", "additionalProperties": False,
    "required": ["requestId", "principal", "actor", "applicationId", "spaceId", "items", "requestExpiresAt"],
    "properties": {
        "requestId": {"type": "string", "pattern": "^arq_"},
        "principal": {"type": "object", "additionalProperties": False, "required": ["type", "id"], "properties": {"type": {"const": "user"}, "id": {"type": "string", "pattern": "^usr_"}}},
        "actor": {"type": "object", "additionalProperties": False, "required": ["type", "id"], "properties": {"type": {"const": "agent"}, "id": {"type": "string", "pattern": "^agt_"}}},
        "applicationId": {"type": "string", "minLength": 1},
        "spaceId": {"type": "string", "pattern": "^spc_"},
        "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/AuthorizationRequestItem"}},
        "requestExpiresAt": {"type": "string", "format": "date-time"},
    },
    "description": "Canonical structured human-review projection derived from immutable stored request state. Presentation data, not a second Authority source.",
}
schemas["CreateAuthorizationRequest"] = {
    "type": "object", "additionalProperties": False, "required": ["principalUserId", "items"],
    "properties": {
        "principalUserId": {"type": "string", "pattern": "^usr_[A-Za-z0-9_-]+$", "description": "Trusted server-side intended User context. This value is not authentication and must never be an AI argument; request creation grants no Authority."},
        "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "object", "additionalProperties": False, "required": ["scope"], "properties": {"scope": {"$ref": "#/components/schemas/DelegationScope"}, "constraints": {"$ref": "#/components/schemas/DelegationConstraints"}}}},
        "requestTtlMinutes": {"type": "integer", "minimum": 1, "maximum": 1440, "default": 60},
        "correlation": {"$ref": "#/components/schemas/AuthorizationRequestCorrelation"},
    },
}
schemas["ConfirmAuthorizationRequest"] = {
    "type": "object", "additionalProperties": False,
    "properties": {"confirmation": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation"}},
}
schemas["AuthorizationRequest"] = {
    "type": "object", "additionalProperties": False,
    "required": ["id", "status", "principal", "actor", "applicationId", "spaceId", "items", "requestTtlMinutes", "createdAt", "expiresAt", "transitionedAt", "correlation", "confirmation"],
    "properties": {
        "id": {"type": "string", "pattern": "^arq_"},
        "status": {"type": "string", "enum": ["pending", "approved", "denied", "cancelled", "expired"]},
        "principal": {"type": "object", "additionalProperties": False, "required": ["type", "id"], "properties": {"type": {"const": "user"}, "id": {"type": "string", "pattern": "^usr_"}}},
        "actor": {"type": "object", "additionalProperties": False, "required": ["type", "id"], "properties": {"type": {"const": "agent"}, "id": {"type": "string", "pattern": "^agt_"}}},
        "applicationId": {"type": "string", "minLength": 1},
        "spaceId": {"type": "string", "pattern": "^spc_"},
        "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/AuthorizationRequestItem"}},
        "requestTtlMinutes": {"type": "integer", "minimum": 1, "maximum": 1440},
        "createdAt": {"type": "string", "format": "date-time"},
        "expiresAt": {"type": "string", "format": "date-time"},
        "transitionedAt": {"anyOf": [{"type": "string", "format": "date-time"}, {"type": "null"}]},
        "correlation": {"anyOf": [{"$ref": "#/components/schemas/AuthorizationRequestCorrelation"}, {"type": "null"}]},
        "confirmation": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation"},
        "reused": {"type": "boolean"},
        "delegations": {"type": "array", "maxItems": 20, "items": {"$ref": "#/components/schemas/Delegation"}},
    },
}
schemas["AuthorizationRequestResponse"] = {
    "type": "object", "additionalProperties": False, "required": ["data"],
    "properties": {"data": {"$ref": "#/components/schemas/AuthorizationRequest"}},
}
schemas["StatusResponse"]["properties"]["data"]["properties"]["contractVersion"]["const"] = "0.45.0"
openapi_path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")

# Extend the contract gate rather than weakening it.
check = ROOT / "apps/core/scripts/check-openapi.mjs"
check_text = check.read_text()
check_text = check_text.replace('document.info?.version !== "0.44.0"', 'document.info?.version !== "0.45.0"', 1)
required_anchor = '  "/api/v1/spaces/{spaceId}/delegations",\n'
required_insert = '''  "/api/v1/spaces/{spaceId}/authorization-requests",\n  "/api/v1/spaces/{spaceId}/authorization-requests/{requestId}",\n  "/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/confirm",\n  "/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/deny",\n  "/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/cancel",\n'''
if check_text.count(required_anchor) != 1:
    raise SystemExit("check-openapi required path anchor missing")
check_text = check_text.replace(required_anchor, required_insert + required_anchor, 1)
contract_anchor = '''if (schemas.CreateDelegationBatchRequest?.properties?.items?.minItems !== 1\n'''
assertion = '''const authorizationCreate = document.paths?.["/api/v1/spaces/{spaceId}/authorization-requests"]?.post;\nconst authorizationConfirm = document.paths?.["/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/confirm"]?.post;\nif (authorizationCreate?.operationId !== "createAuthorizationRequest"\n    || authorizationCreate?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/CreateAuthorizationRequest"\n    || authorizationConfirm?.operationId !== "confirmAuthorizationRequest"\n    || authorizationConfirm?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ConfirmAuthorizationRequest") {\n  throw new Error("Authorization Request lifecycle contract is missing or malformed");\n}\nif (schemas.CreateAuthorizationRequest?.properties?.items?.minItems !== 1\n    || schemas.CreateAuthorizationRequest?.properties?.items?.maxItems !== 20\n    || schemas.CreateAuthorizationRequest?.properties?.requestTtlMinutes?.default !== 60\n    || schemas.CreateAuthorizationRequest?.properties?.requestTtlMinutes?.maximum !== 1440\n    || JSON.stringify(schemas.AuthorizationRequest?.properties?.status?.enum) !== JSON.stringify(["pending", "approved", "denied", "cancelled", "expired"])) {\n  throw new Error("Authorization Request bounds/lifecycle semantics drifted");\n}\n\n'''
if check_text.count(contract_anchor) != 1:
    raise SystemExit("check-openapi delegation bound anchor missing")
check_text = check_text.replace(contract_anchor, assertion + contract_anchor, 1)
check.write_text(check_text)

# Human-readable contract/Agent boundary.
agent_ready = ROOT / "docs/agent-ready.md"
agent_text = agent_ready.read_text()
append = '''\n## Authorization Request protocol\n\n`arq_*` is the durable transport-independent pending user-confirmation state for Agent integrations. Request creation grants no Authority. The authenticated Agent/Application may carry an already-resolved trusted workflow `usr_*` as the intended user context, but that value is not authentication and must never become an AI argument. Core owns immutable requested scopes, request TTL (default 60 minutes, bounded 1..1440), pending reuse, terminal state, and canonical confirmation projection.\n\nLifecycle is `pending -> approved | denied | cancelled | expired`. `denied` means the trusted presentation workflow reports explicit user rejection; `cancelled` means the requesting Agent/Application no longer needs the request. `sessionId` / `conversationId` are correlation only.\n\nConfirm re-reads canonical request state, optionally validates structured confirmation equality, rechecks current User Authority + credential scope + Application × Model Access, and atomically records approval together with the independent single-scope `dlg_*` rows by reusing the same #298 Delegation issuance primitive. A terminal-transition uniqueness row is the concurrency boundary, so concurrent confirm/deny/cancel cannot create partial approval. Chat/WeCom/n8n presentation and routing remain adapter/application concerns, not Core orchestration.\n'''
if "## Authorization Request protocol" not in agent_text:
    agent_ready.write_text(agent_text.rstrip() + "\n" + append)

contracts = ROOT / "docs/contracts.md"
contracts_text = contracts.read_text()
contracts_text = contracts_text.replace("Core Kernel `0.44.0`", "Core Kernel `0.45.0`", 1) if "Core Kernel `0.44.0`" in contracts_text else contracts_text
if "Authorization Request" not in contracts_text:
    contracts_text += "\n- Kernel 0.45.0 adds transport-independent `arq_*` Authorization Request lifecycle endpoints. Request creation is non-authorizing; Confirm reuses atomic Delegation issuance and current Authority checks.\n"
contracts.write_text(contracts_text)

# Integration tests.
test_source = r'''import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type KeyPair = { privateKey: string; publicKey: string };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function agentToken(privateKey: string, agentId: string, appId: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: agentId,
    azp: appId,
    principal_type: "agent",
    principal_id: agentId,
    actor_type: "agent",
    actor_id: agentId,
    purpose: "agent_execution",
    scope: "resources:read resources:write resources:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, path: string, bearer: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function json(response: Response): Promise<any> { return response.json<any>(); }

async function seed(userId: string, spaceId: string, appId: string) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authorization request", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
    ...["event", "task"].map((modelKey) => db.prepare(`INSERT INTO application_model_access(
      application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
      .bind(appId, modelKey, "manage", "user", userId, now, now)),
  ]);
}

function createBody(userId: string) {
  return {
    principalUserId: userId,
    requestTtlMinutes: 60,
    correlation: { sessionId: "session-1", conversationId: "conversation-1" },
    items: [
      { scope: { target: { type: "model", id: "event" }, maxAccess: "write" } },
      { scope: { target: { type: "model", id: "task" }, maxAccess: "read" }, constraints: { maxUses: 1 } },
    ],
  };
}

async function createRequest(publicKey: string, bearer: string, spaceId: string, userId: string) {
  return request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests`, bearer, {
    method: "POST",
    body: JSON.stringify(createBody(userId)),
  });
}

async function count(db: D1Database, table: string, requestId?: string): Promise<number> {
  const row = requestId
    ? await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE request_id=?`).bind(requestId).first<{ count: number }>()
    : await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

describe("Authorization Request protocol", () => {
  it("creates no Authority, reuses identical pending requests, validates confirmation and atomically issues Delegations", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_${suffix}`;
    const agentId = `agt_arq_${suffix}`;
    const spaceId = `spc_arq_${suffix}`;
    const appId = `app_arq_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;

    const first = await createRequest(publicKey, bearer, spaceId, userId);
    expect(first.status).toBe(201);
    const created = (await json(first)).data;
    expect(created.id).toMatch(/^arq_/u);
    expect(created.status).toBe("pending");
    expect(created.reused).toBe(false);
    expect(created.confirmation.items).toHaveLength(2);
    expect(await count(db, "delegations")).toBe(0);

    const second = await createRequest(publicKey, bearer, spaceId, userId);
    expect(second.status).toBe(200);
    const reused = (await json(second)).data;
    expect(reused.id).toBe(created.id);
    expect(reused.reused).toBe(true);
    expect(await count(db, "authorization_requests")).toBe(1);

    const mutated = structuredClone(created.confirmation);
    mutated.items[0].scope.maxAccess = "read";
    const mismatch = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, {
      method: "POST", body: JSON.stringify({ confirmation: mutated }),
    });
    expect(mismatch.status).toBe(409);
    expect((await json(mismatch)).error.code).toBe("CONFIRMATION_MISMATCH");
    expect(await count(db, "delegations")).toBe(0);

    const confirmed = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, {
      method: "POST", body: JSON.stringify({ confirmation: created.confirmation }),
    });
    expect(confirmed.status).toBe(200);
    const approved = (await json(confirmed)).data;
    expect(approved.status).toBe("approved");
    expect(approved.delegations).toHaveLength(2);
    expect(approved.delegations.every((item: any) => item.principal.id === userId && item.actor.id === agentId)).toBe(true);
    expect(approved.delegations.every((item: any) => item.createdBy.id === agentId)).toBe(true);
    expect(await count(db, "delegations")).toBe(2);
    expect(await count(db, "authorization_request_delegations", created.id)).toBe(2);

    const repeated = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, {
      method: "POST", body: JSON.stringify({}),
    });
    expect(repeated.status).toBe(200);
    const repeatedData = (await json(repeated)).data;
    expect(repeatedData.delegations.map((item: any) => item.id)).toEqual(approved.delegations.map((item: any) => item.id));
    expect(await count(db, "delegations")).toBe(2);
  });

  it("keeps deny and cancel distinct and never issues Authority", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_terminal_${suffix}`;
    const agentId = `agt_arq_terminal_${suffix}`;
    const spaceId = `spc_arq_terminal_${suffix}`;
    const appId = `app_arq_terminal_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;

    const deniedRequest = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    const denied = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, { method: "POST" });
    expect(denied.status).toBe(200);
    expect((await json(denied)).data.status).toBe("denied");
    const afterDeny = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/confirm`, bearer, { method: "POST" });
    expect(afterDeny.status).toBe(409);

    const cancelRequestResponse = await createRequest(publicKey, bearer, spaceId, userId);
    expect(cancelRequestResponse.status).toBe(201);
    const cancelRequest = (await json(cancelRequestResponse)).data;
    expect(cancelRequest.id).not.toBe(deniedRequest.id);
    const cancelled = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${cancelRequest.id}/cancel`, bearer, { method: "POST" });
    expect(cancelled.status).toBe(200);
    expect((await json(cancelled)).data.status).toBe("cancelled");
    expect(await count(db, "delegations")).toBe(0);
  });

  it("rechecks current User Authority at confirm and leaves the request pending on failure", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_stale_${suffix}`;
    const agentId = `agt_arq_stale_${suffix}`;
    const spaceId = `spc_arq_stale_${suffix}`;
    const appId = `app_arq_stale_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;
    const created = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;

    await db.prepare("DELETE FROM space_memberships WHERE space_id=? AND user_id=?").bind(spaceId, userId).run();
    const response = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST" });
    expect(response.status).toBe(403);
    expect(await count(db, "delegations")).toBe(0);
    const loaded = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}`, bearer);
    expect((await json(loaded)).data.status).toBe("pending");
  });

  it("derives expiry and refuses terminal transition after TTL", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_expired_${suffix}`;
    const agentId = `agt_arq_expired_${suffix}`;
    const spaceId = `spc_arq_expired_${suffix}`;
    const appId = `app_arq_expired_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;
    const created = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;
    await db.prepare("UPDATE authorization_requests SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 1000).toISOString(), created.id).run();

    const loaded = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}`, bearer);
    expect((await json(loaded)).data.status).toBe("expired");
    const confirm = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST" });
    expect(confirm.status).toBe(409);
    expect((await json(confirm)).error.code).toBe("AUTHORIZATION_REQUEST_EXPIRED");
    expect(await count(db, "delegations")).toBe(0);
  });

  it("allows exactly one terminal decision under concurrent confirm/deny", async () => {
    const { privateKey, publicKey } = await keys();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const userId = `usr_arq_race_${suffix}`;
    const agentId = `agt_arq_race_${suffix}`;
    const spaceId = `spc_arq_race_${suffix}`;
    const appId = `app_arq_race_${suffix}`;
    await seed(userId, spaceId, appId);
    const bearer = await agentToken(privateKey, agentId, appId);
    const db = (env as unknown as TestEnv).DB;
    const created = (await json(await createRequest(publicKey, bearer, spaceId, userId))).data;

    const [confirm, deny] = await Promise.all([
      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST" }),
      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/deny`, bearer, { method: "POST" }),
    ]);
    expect([confirm.status, deny.status].filter((value) => value === 200).length).toBeGreaterThanOrEqual(1);
    const transitionCount = await count(db, "authorization_request_transitions", created.id);
    expect(transitionCount).toBe(1);
    const loaded = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}`, bearer);
    const final = (await json(loaded)).data;
    expect(["approved", "denied"]).toContain(final.status);
    if (final.status === "approved") expect(await count(db, "delegations")).toBe(2);
    else expect(await count(db, "delegations")).toBe(0);
  });
});
'''
(ROOT / "apps/core/test/authorization-request.integration.test.ts").write_text(test_source)

print("Applied LifeSpace #306 Authorization Request implementation")

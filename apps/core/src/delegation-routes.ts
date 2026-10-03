import type { Hono } from "hono";
import { requireSpacePermission, type Permission } from "./authorization";
import {
  delegationChainStatement,
  delegationExpiryNarrows,
  delegationScopeContains,
  validateStructuralDelegationChain,
  type DelegationChainRow,
} from "./delegation-chain";
import {
  canDelegateOwnAuthority,
  canReceiveDelegation,
  isEntityType,
} from "./entity-role-capability";
import type { Actor, Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { requireModelAccess } from "./model-authorization";
import type { ModelAccess } from "./model-definition";
import { getRuntimeModel } from "./model-registry";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type DelegationTargetType = "space" | "model" | "record";
type DelegationAccess = Permission;
type DelegationActorInput = { type?: unknown; id?: unknown };
type DelegationTargetInput = { type?: unknown; id?: unknown };
type DelegationScopeInput = { target?: unknown; maxAccess?: unknown };
type DelegationConstraintsInput = {
  maxUses?: unknown;
  expiresAt?: unknown;
  remainingRedelegationDepth?: unknown;
};
type CreateDelegationBody = {
  actor?: unknown;
  parentDelegationId?: unknown;
  scope?: unknown;
  constraints?: unknown;
};

type DelegationRow = {
  id: string;
  principal_type: Principal["type"];
  principal_id: string;
  actor_type: Actor["type"];
  actor_id: string;
  application_id: string;
  source_space_id: string;
  parent_delegation_id: string | null;
  remaining_redelegation_depth: number;
  created_by_type: Actor["type"];
  created_by_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  max_uses: number | null;
  consumed_at: string | null;
  target_type: DelegationTargetType;
  target_id: string;
  target_model_key: string | null;
  max_access: DelegationAccess;
};

type ParsedScope = {
  target: { type: DelegationTargetType; id: string };
  maxAccess: DelegationAccess;
};

type ParsedConstraints = {
  maxUses: 1 | null;
  expiresAt: string | null;
  remainingRedelegationDepth: number;
};

const MAX_REDELEGATION_DEPTH = 3;
const delegationAccess = new Set<DelegationAccess>(["free_busy", "read", "write", "manage"]);
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function executionActor(principal: Principal): Actor {
  return principal.actor ?? { type: principal.type, id: principal.id };
}

function directPrincipal(principal: Principal): Principal {
  if (!principal.actor) return principal;
  const { actor: _actor, ...direct } = principal;
  return direct;
}

function requireDirectDelegatingPrincipal(principal: Principal): void {
  if (principal.actor || !canDelegateOwnAuthority(principal.type)) {
    throw new ApiError("FORBIDDEN", "Direct Principal is not allowed to delegate its own Authority", 403);
  }
}

function parseActor(value: unknown): Actor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "actor must be an object", 400);
  }
  const input = value as DelegationActorInput;
  if (Object.keys(input).some((key) => !["type", "id"].includes(key))) {
    throw new ApiError("INVALID_REQUEST", "actor accepts only type and id", 400);
  }
  if (!isEntityType(input.type)) {
    throw new ApiError("INVALID_REQUEST", "actor.type must be a known LifeSpace Entity Type", 400);
  }
  if (!canReceiveDelegation(input.type)) {
    throw new ApiError("FORBIDDEN", `${input.type} is not currently allowed to receive Delegation`, 403);
  }
  if (typeof input.id !== "string" || !input.id.trim()) {
    throw new ApiError("INVALID_REQUEST", "actor.id is required", 400);
  }
  const actorId = input.id.trim();
  if (input.type === "agent" && !/^agt_[A-Za-z0-9_-]+$/u.test(actorId)) {
    throw new ApiError("INVALID_REQUEST", "Agent Actor must use a valid agt_* identifier", 400);
  }
  return { type: input.type, id: actorId };
}

function parseExpiry(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("INVALID_REQUEST", "constraints.expiresAt must be an RFC 3339 date-time or null", 400);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || !/T/u.test(value)) {
    throw new ApiError("INVALID_REQUEST", "constraints.expiresAt must be an RFC 3339 date-time", 400);
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ApiError("INVALID_REQUEST", "constraints.expiresAt must be in the future", 400);
  }
  return parsed.toISOString();
}

function parseRemainingDepth(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_REDELEGATION_DEPTH) {
    throw new ApiError(
      "INVALID_REQUEST",
      `constraints.remainingRedelegationDepth must be an integer between 0 and ${MAX_REDELEGATION_DEPTH}`,
      400,
    );
  }
  return Number(value);
}

function parseConstraints(value: unknown): ParsedConstraints {
  if (value === undefined || value === null) {
    return { maxUses: null, expiresAt: null, remainingRedelegationDepth: 0 };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "constraints must be an object", 400);
  }
  const input = value as DelegationConstraintsInput;
  const unknown = Object.keys(input)
    .find((key) => !["maxUses", "expiresAt", "remainingRedelegationDepth"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported constraints field ${unknown}`, 400);
  if (input.maxUses !== undefined && input.maxUses !== 1) {
    throw new ApiError("INVALID_REQUEST", "constraints.maxUses currently supports only 1", 400);
  }
  return {
    maxUses: input.maxUses === 1 ? 1 : null,
    expiresAt: parseExpiry(input.expiresAt),
    remainingRedelegationDepth: parseRemainingDepth(input.remainingRedelegationDepth),
  };
}

function parseScope(value: unknown): ParsedScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "scope must be an object", 400);
  }
  const input = value as DelegationScopeInput;
  if (Object.keys(input).some((key) => !["target", "maxAccess"].includes(key))) {
    throw new ApiError("INVALID_REQUEST", "scope accepts only target and maxAccess", 400);
  }
  if (!input.target || typeof input.target !== "object" || Array.isArray(input.target)) {
    throw new ApiError("INVALID_REQUEST", "scope.target must be an object", 400);
  }
  const target = input.target as DelegationTargetInput;
  if (Object.keys(target).some((key) => !["type", "id"].includes(key))) {
    throw new ApiError("INVALID_REQUEST", "scope.target accepts only type and id", 400);
  }
  if (!["space", "model", "record"].includes(String(target.type))) {
    throw new ApiError("INVALID_REQUEST", "scope.target.type must be space, model or record", 400);
  }
  if (typeof target.id !== "string" || !target.id.trim()) {
    throw new ApiError("INVALID_REQUEST", "scope.target.id is required", 400);
  }
  if (typeof input.maxAccess !== "string" || !delegationAccess.has(input.maxAccess as DelegationAccess)) {
    throw new ApiError("INVALID_REQUEST", "scope.maxAccess must be free_busy, read, write or manage", 400);
  }

  const type = target.type as DelegationTargetType;
  const targetId = target.id.trim();
  if (type === "space" && !/^spc_[A-Za-z0-9_-]+$/u.test(targetId)) {
    throw new ApiError("INVALID_REQUEST", "Space target must be a valid spc_* identifier", 400);
  }
  if (type === "record" && !/^rec_[A-Za-z0-9_-]+$/u.test(targetId)) {
    throw new ApiError("INVALID_REQUEST", "Record target must be a valid rec_* identifier", 400);
  }
  if (type === "model" && (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(targetId) || targetId.length > 100)) {
    throw new ApiError("INVALID_REQUEST", "Model target must be a valid modelKey", 400);
  }
  if (type !== "space" && input.maxAccess === "free_busy") {
    throw new ApiError("INVALID_REQUEST", "free_busy is supported only for Space-scoped Delegation", 400);
  }
  return {
    target: { type, id: targetId },
    maxAccess: input.maxAccess as DelegationAccess,
  };
}

function parseParentDelegationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^dlg_[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ApiError("INVALID_REQUEST", "parentDelegationId must be a valid dlg_* identifier", 400);
  }
  return value;
}

function effectiveStatus(
  row: Pick<DelegationRow, "revoked_at" | "consumed_at" | "expires_at">,
): "active" | "revoked" | "consumed" | "expired" {
  if (row.revoked_at) return "revoked";
  if (row.consumed_at) return "consumed";
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return "expired";
  return "active";
}

function dto(row: DelegationRow) {
  return {
    id: row.id,
    principal: { type: row.principal_type, id: row.principal_id },
    actor: { type: row.actor_type, id: row.actor_id },
    applicationId: row.application_id,
    spaceId: row.source_space_id,
    parentDelegationId: row.parent_delegation_id,
    scope: {
      target: { type: row.target_type, id: row.target_id },
      maxAccess: row.max_access,
    },
    constraints: {
      ...(row.max_uses === 1 ? { maxUses: 1 } : {}),
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      remainingRedelegationDepth: row.remaining_redelegation_depth,
    },
    createdBy: { type: row.created_by_type, id: row.created_by_id },
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at,
    effectiveStatus: effectiveStatus(row),
  };
}

async function validateScopeAuthority(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  scope: ParsedScope,
): Promise<string | null> {
  if (scope.target.type === "space") {
    if (scope.target.id !== spaceId) {
      throw new ApiError("INVALID_REQUEST", "Space Delegation target must equal the route Space", 400);
    }
    await requireSpacePermission(env, principal, spaceId, scope.maxAccess);
    return null;
  }

  if (scope.target.type === "model") {
    const model = await getRuntimeModel(env, scope.target.id);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${scope.target.id} not found`, 404);
    await requireModelAccess(env, principal, spaceId, model, scope.maxAccess as ModelAccess);
    return model.key;
  }

  const resource = await env.DB.prepare(`SELECT model_key FROM resource_records
    WHERE id=? AND space_id=? AND deleted_at IS NULL LIMIT 1`)
    .bind(scope.target.id, spaceId)
    .first<{ model_key: string }>();
  if (!resource) throw new ApiError("RESOURCE_NOT_FOUND", "Record Delegation target was not found", 404);
  const model = await getRuntimeModel(env, resource.model_key);
  if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${resource.model_key} not found`, 404);
  await requireModelAccess(
    env,
    principal,
    spaceId,
    model,
    scope.maxAccess as ModelAccess,
    { recordId: scope.target.id },
  );
  return model.key;
}

async function loadCurrentParentChain(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  parentDelegationId: string,
): Promise<DelegationChainRow[]> {
  const [result] = await env.DB.batch<Record<string, unknown>>([
    delegationChainStatement(env, [parentDelegationId]),
  ]);
  const rows = (result?.results ?? []) as DelegationChainRow[];
  return validateStructuralDelegationChain(principal, spaceId, parentDelegationId, rows);
}

function childScopeShape(
  spaceId: string,
  scope: ParsedScope,
  targetModelKey: string | null,
): Pick<
  DelegationChainRow,
  "delegation_target_type" | "delegation_target_id" | "delegation_target_model_key" | "delegation_max_access" | "source_space_id"
> {
  return {
    delegation_target_type: scope.target.type,
    delegation_target_id: scope.target.id,
    delegation_target_model_key: targetModelKey,
    delegation_max_access: scope.maxAccess,
    source_space_id: spaceId,
  };
}

function assertChildNarrowing(
  parent: DelegationChainRow,
  spaceId: string,
  scope: ParsedScope,
  targetModelKey: string | null,
  constraints: ParsedConstraints,
): void {
  if (parent.remaining_redelegation_depth <= 0) {
    throw new ApiError("DELEGATION_INVALID", "Parent Delegation does not permit re-delegation", 403);
  }
  if (constraints.remainingRedelegationDepth >= parent.remaining_redelegation_depth) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "Child remaining re-delegation depth must be lower than the parent",
      403,
    );
  }
  if (!delegationScopeContains(parent, childScopeShape(spaceId, scope, targetModelKey))) {
    throw new ApiError("DELEGATION_SCOPE_INSUFFICIENT", "Child Delegation would widen parent scope or access", 403);
  }
  if (!delegationExpiryNarrows(parent.delegation_expires_at, constraints.expiresAt)) {
    throw new ApiError("DELEGATION_INVALID", "Child Delegation expiry cannot exceed parent expiry", 403);
  }
}

function selectRowsSql(): string {
  return `SELECT
    d.id,d.principal_type,d.principal_id,d.actor_type,d.actor_id,d.application_id,d.source_space_id,
    d.parent_delegation_id,d.remaining_redelegation_depth,d.created_by_type,d.created_by_id,
    d.created_at,d.expires_at,d.revoked_at,d.max_uses,d.consumed_at,
    s.target_type,s.target_id,s.target_model_key,s.max_access
  FROM delegations d
  JOIN delegation_scopes s ON s.delegation_id=d.id`;
}

export function registerDelegationRoutes(app: App): void {
  app.get("/api/v1/spaces/:spaceId/delegations", async (context) => {
    const principal = context.get("principal");
    requireDirectDelegatingPrincipal(principal);
    const rows = await context.env.DB.prepare(`${selectRowsSql()}
      JOIN spaces sp ON sp.id=d.source_space_id AND sp.deleted_at IS NULL
      WHERE d.source_space_id=? AND d.principal_type=? AND d.principal_id=?
        AND d.application_id=?
      ORDER BY d.created_at DESC,d.id`)
      .bind(context.req.param("spaceId"), principal.type, principal.id, principal.clientId)
      .all<DelegationRow>();
    return context.json(success({ items: rows.results.map(dto) }));
  });

  app.post("/api/v1/spaces/:spaceId/delegations", async (context) => {
    const principal = context.get("principal");
    const body = await context.req.json<CreateDelegationBody>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
    }
    const unknown = Object.keys(body)
      .find((key) => !["actor", "parentDelegationId", "scope", "constraints"].includes(key));
    if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported field ${unknown}`, 400);

    const delegatedActor = parseActor(body.actor);
    const parentDelegationId = parseParentDelegationId(body.parentDelegationId);
    const scope = parseScope(body.scope);
    const constraints = parseConstraints(body.constraints);
    const spaceId = context.req.param("spaceId");

    if (principal.actor && !parentDelegationId) {
      throw new ApiError(
        "DELEGATION_REQUIRED",
        "Represented Actor may issue only a Child Delegation from an explicit parent",
        403,
      );
    }
    if (!principal.actor && parentDelegationId) {
      throw new ApiError(
        "INVALID_REQUEST",
        "Direct Principal delegation does not use parentDelegationId",
        400,
      );
    }
    if (!principal.actor && !canDelegateOwnAuthority(principal.type)) {
      throw new ApiError("FORBIDDEN", "Principal is not allowed to delegate its own Authority", 403);
    }

    // Delegation can never outlive or widen the Root Principal's current Authority.
    // For represented issuance we deliberately inspect the Root Principal's own
    // current Authority independently from the parent chain.
    const targetModelKey = await validateScopeAuthority(
      context.env,
      directPrincipal(principal),
      spaceId,
      scope,
    );

    let parent: DelegationChainRow | null = null;
    if (parentDelegationId) {
      const parentChain = await loadCurrentParentChain(
        context.env,
        principal,
        spaceId,
        parentDelegationId,
      );
      parent = parentChain[parentChain.length - 1]!;
      assertChildNarrowing(parent, spaceId, scope, targetModelKey, constraints);
    }

    const delegationId = id("dlg");
    const timestamp = new Date().toISOString();
    const issuer = executionActor(principal);
    await context.env.DB.batch([
      context.env.DB.prepare(`INSERT INTO delegations(
        id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
        created_by_type,created_by_id,created_at,expires_at,max_uses,
        parent_delegation_id,remaining_redelegation_depth
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        delegationId,
        principal.type,
        principal.id,
        delegatedActor.type,
        delegatedActor.id,
        principal.clientId,
        spaceId,
        issuer.type,
        issuer.id,
        timestamp,
        constraints.expiresAt,
        constraints.maxUses,
        parent?.delegation_id ?? null,
        constraints.remainingRedelegationDepth,
      ),
      context.env.DB.prepare(`INSERT INTO delegation_scopes(
        delegation_id,target_type,target_id,target_model_key,max_access
      ) VALUES(?,?,?,?,?)`).bind(
        delegationId,
        scope.target.type,
        scope.target.id,
        targetModelKey,
        scope.maxAccess,
      ),
    ]);

    const row = await context.env.DB.prepare(`${selectRowsSql()} WHERE d.id=?`)
      .bind(delegationId)
      .first<DelegationRow>();
    if (!row) throw new Error("Delegation missing after create");
    return context.json(success(dto(row)), 201);
  });

  app.delete("/api/v1/spaces/:spaceId/delegations/:delegationId", async (context) => {
    const principal = context.get("principal");
    const callerActor = executionActor(principal);
    const spaceId = context.req.param("spaceId");
    const delegationId = context.req.param("delegationId");

    const row = await context.env.DB.prepare(`SELECT
        id,principal_type,principal_id,application_id,source_space_id,parent_delegation_id,
        created_by_type,created_by_id,revoked_at,consumed_at
      FROM delegations
      WHERE id=? AND source_space_id=? AND application_id=?
      LIMIT 1`)
      .bind(delegationId, spaceId, principal.clientId)
      .first<Pick<DelegationRow,
        "id" | "principal_type" | "principal_id" | "application_id" | "source_space_id"
        | "parent_delegation_id" | "created_by_type" | "created_by_id" | "revoked_at" | "consumed_at"
      >>();

    if (!row || row.revoked_at || row.consumed_at) {
      throw new ApiError("DELEGATION_NOT_FOUND", "Active Delegation not found", 404);
    }

    const rootPrincipalMayRevoke = !principal.actor
      && canDelegateOwnAuthority(principal.type)
      && row.principal_type === principal.type
      && row.principal_id === principal.id;
    const immediateIssuerMayRevoke = row.parent_delegation_id !== null
      && row.created_by_type === callerActor.type
      && row.created_by_id === callerActor.id;

    if (!rootPrincipalMayRevoke && !immediateIssuerMayRevoke) {
      // Keep the management surface opaque to callers without revoke authority.
      throw new ApiError("DELEGATION_NOT_FOUND", "Active Delegation not found", 404);
    }

    const revokedAt = new Date().toISOString();
    const result = await context.env.DB.prepare(`UPDATE delegations SET revoked_at=?
      WHERE id=? AND source_space_id=? AND application_id=?
        AND revoked_at IS NULL AND consumed_at IS NULL`)
      .bind(revokedAt, delegationId, spaceId, principal.clientId).run();
    if (!result.meta.changes) {
      throw new ApiError("DELEGATION_NOT_FOUND", "Active Delegation not found", 404);
    }
    return context.body(null, 204);
  });
}

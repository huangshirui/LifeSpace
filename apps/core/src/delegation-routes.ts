import type { Hono } from "hono";
import { requireSpacePermission, type Permission } from "./authorization";
import {
  delegationChainStatement,
  delegationExpiryNarrows,
  delegationScopeContains,
  groupDelegationChainRows,
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
import { requireModelAccessMany } from "./model-authorization";
import type { ModelAccess } from "./model-definition";
import { resolveSpaceAuthorityModel } from "./external-model";

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
type CreateDelegationBatchBody = { items?: unknown };
type ParsedDelegationIssue = {
  actor: Actor;
  parentDelegationId: string | null;
  scope: ParsedScope;
  constraints: ParsedConstraints;
};
export type PreparedDelegationIssue = ParsedDelegationIssue & {
  delegationId: string;
  targetModelKey: string | null;
  parent: DelegationChainRow | null;
  createdAt: string;
  issuer: Actor;
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

export type ParsedScope = {
  target: { type: DelegationTargetType; id: string };
  maxAccess: DelegationAccess;
};

export type ParsedConstraints = {
  maxUses: 1 | null;
  expiresAt: string | null;
  remainingRedelegationDepth: number;
};

const MAX_REDELEGATION_DEPTH = 3;
const MAX_ATOMIC_DELEGATION_ISSUES = 20;
const delegationAccess = new Set<DelegationAccess>(["free_busy", "read", "write", "manage"]);
const delegationAccessRank: Record<DelegationAccess, number> = { free_busy: 1, read: 2, write: 3, manage: 4 };
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


function parseCreateDelegationBody(value: unknown): ParsedDelegationIssue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Delegation item must be a JSON object", 400);
  }
  const body = value as CreateDelegationBody;
  const unknown = Object.keys(body)
    .find((key) => !["actor", "parentDelegationId", "scope", "constraints"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported Delegation field ${unknown}`, 400);
  return {
    actor: parseActor(body.actor),
    parentDelegationId: parseParentDelegationId(body.parentDelegationId),
    scope: parseScope(body.scope),
    constraints: parseConstraints(body.constraints),
  };
}

export function parseAuthorizationRequestItem(
  actor: Actor,
  value: unknown,
): { scope: ParsedScope; constraints: ParsedConstraints } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_REQUEST", "Authorization Request item must be a JSON object", 400);
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find((key) => !["scope", "constraints"].includes(key));
  if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported Authorization Request item field ${unknown}`, 400);
  const parsed = parseCreateDelegationBody({ actor, scope: input.scope, constraints: input.constraints });
  return { scope: parsed.scope, constraints: parsed.constraints };
}

function assertIssuanceProfile(principal: Principal, issue: ParsedDelegationIssue): void {
  if (principal.actor && !issue.parentDelegationId) {
    throw new ApiError(
      "DELEGATION_REQUIRED",
      "Represented Actor may issue only a Child Delegation from an explicit parent",
      403,
    );
  }
  if (!principal.actor && issue.parentDelegationId) {
    throw new ApiError(
      "INVALID_REQUEST",
      "Direct Principal delegation does not use parentDelegationId",
      400,
    );
  }
  if (!principal.actor && !canDelegateOwnAuthority(principal.type)) {
    throw new ApiError("FORBIDDEN", "Principal is not allowed to delegate its own Authority", 403);
  }
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

async function validateScopesAuthorityMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  scopes: readonly ParsedScope[],
): Promise<(string | null)[]> {
  const rootPrincipal = directPrincipal(principal);
  const targetModelKeys = Array<string | null>(scopes.length).fill(null);

  let strongestSpacePermission: Permission | null = null;
  const recordIndexes: number[] = [];
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]!;
    if (scope.target.type === "space") {
      if (scope.target.id !== spaceId) {
        throw new ApiError("INVALID_REQUEST", "Space Delegation target must equal the route Space", 400);
      }
      if (!strongestSpacePermission
          || delegationAccessRank[scope.maxAccess] > delegationAccessRank[strongestSpacePermission]) {
        strongestSpacePermission = scope.maxAccess;
      }
    } else if (scope.target.type === "model") {
      targetModelKeys[index] = scope.target.id;
    } else {
      recordIndexes.push(index);
    }
  }

  if (recordIndexes.length) {
    const recordIds = [...new Set(recordIndexes.map((index) => scopes[index]!.target.id))];
    const placeholders = recordIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(`SELECT id,model_key FROM resource_records
      WHERE space_id=? AND deleted_at IS NULL AND id IN (${placeholders})`)
      .bind(spaceId, ...recordIds)
      .all<{ id: string; model_key: string }>();
    const byId = new Map(rows.results.map((row) => [row.id, row.model_key]));
    const externalIds=recordIds.filter(id=>id.startsWith("rec_external_"));
    if(externalIds.length){
      const external=await env.DB.prepare(`SELECT i.record_id id,COALESCE(m.definition_key,i.model_key) model_key FROM external_record_identities i JOIN external_models m ON m.model_key=i.model_key JOIN external_sources s ON s.id=m.source_id WHERE i.space_id=? AND m.status!='disabled' AND s.status='active' AND i.record_id IN (${externalIds.map(()=>"?").join(",")})`).bind(spaceId,...externalIds).all<{id:string;model_key:string}>();
      for(const row of external.results)byId.set(row.id,row.model_key);
    }
    for (const index of recordIndexes) {
      const recordId = scopes[index]!.target.id;
      const modelKey = byId.get(recordId);
      if (!modelKey) throw new ApiError("RESOURCE_NOT_FOUND", "Record Delegation target was not found", 404);
      targetModelKeys[index] = modelKey;
    }
  }

  const distinctModelKeys = [...new Set(targetModelKeys.filter((value): value is string => Boolean(value)))];
  const models = new Map<string, Awaited<ReturnType<typeof resolveSpaceAuthorityModel>>>();
  await Promise.all(distinctModelKeys.map(async (modelKey) => {
    const model = await resolveSpaceAuthorityModel(env, spaceId, modelKey);
    if (!model) throw new ApiError("MODEL_NOT_FOUND", `Published model ${modelKey} not found`, 404);
    models.set(modelKey, model);
  }));

  if (strongestSpacePermission) {
    await requireSpacePermission(env, rootPrincipal, spaceId, strongestSpacePermission);
  }

  const modelRequests = scopes.flatMap((scope, index) => {
    const modelKey = targetModelKeys[index];
    if (!modelKey) return [];
    const model = models.get(modelKey);
    if (!model) throw new Error(`Prepared model ${modelKey} missing`);
    return [{
      model,
      required: scope.maxAccess as ModelAccess,
      selector: scope.target.type === "record" ? { recordId: scope.target.id } : {},
    }];
  });
  await requireModelAccessMany(env, rootPrincipal, spaceId, modelRequests);
  return targetModelKeys;
}

async function loadCurrentParentChains(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  parentDelegationIds: readonly string[],
): Promise<Map<string, DelegationChainRow[]>> {
  if (!parentDelegationIds.length) return new Map();
  const uniqueParentIds = [...new Set(parentDelegationIds)];
  const [result] = await env.DB.batch<Record<string, unknown>>([
    delegationChainStatement(env, uniqueParentIds),
  ]);
  const rows = (result?.results ?? []) as DelegationChainRow[];
  const grouped = groupDelegationChainRows(rows);
  const validated = new Map<string, DelegationChainRow[]>();
  for (const parentDelegationId of uniqueParentIds) {
    validated.set(
      parentDelegationId,
      validateStructuralDelegationChain(
        principal,
        spaceId,
        parentDelegationId,
        grouped.get(parentDelegationId) ?? [],
      ),
    );
  }
  return validated;
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


export async function prepareDelegationIssues(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  values: readonly unknown[],
  issuerOverride?: Actor,
): Promise<PreparedDelegationIssue[]> {
  const issues = values.map(parseCreateDelegationBody);
  for (const issue of issues) assertIssuanceProfile(principal, issue);

  // Validate every requested scope against the Root Principal's current Authority
  // before any Delegation row is written. Model/record Authority is set-wise and
  // record target lookup is bounded independently of item count.
  const targetModelKeys = await validateScopesAuthorityMany(
    env,
    principal,
    spaceId,
    issues.map((issue) => issue.scope),
  );

  const parentIds = issues.flatMap((issue) => issue.parentDelegationId ? [issue.parentDelegationId] : []);
  const parentChains = await loadCurrentParentChains(env, principal, spaceId, parentIds);

  const createdAt = new Date().toISOString();
  const issuer = issuerOverride ?? executionActor(principal);
  return issues.map((issue, index) => {
    let parent: DelegationChainRow | null = null;
    if (issue.parentDelegationId) {
      const chain = parentChains.get(issue.parentDelegationId);
      if (!chain?.length) throw new ApiError("DELEGATION_INVALID", "Parent Delegation was not found", 403);
      parent = chain[chain.length - 1]!;
      assertChildNarrowing(parent, spaceId, issue.scope, targetModelKeys[index]!, issue.constraints);
    }
    return {
      ...issue,
      delegationId: id("dlg"),
      targetModelKey: targetModelKeys[index] ?? null,
      parent,
      createdAt,
      issuer,
    };
  });
}

export function delegationIssueStatements(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  issues: readonly PreparedDelegationIssue[],
): D1PreparedStatement[] {
  return issues.flatMap((issue) => [
    env.DB.prepare(`INSERT INTO delegations(
      id,principal_type,principal_id,actor_type,actor_id,application_id,source_space_id,
      created_by_type,created_by_id,created_at,expires_at,max_uses,
      parent_delegation_id,remaining_redelegation_depth
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      issue.delegationId,
      principal.type,
      principal.id,
      issue.actor.type,
      issue.actor.id,
      principal.clientId,
      spaceId,
      issue.issuer.type,
      issue.issuer.id,
      issue.createdAt,
      issue.constraints.expiresAt,
      issue.constraints.maxUses,
      issue.parent?.delegation_id ?? null,
      issue.constraints.remainingRedelegationDepth,
    ),
    env.DB.prepare(`INSERT INTO delegation_scopes(
      delegation_id,target_type,target_id,target_model_key,max_access
    ) VALUES(?,?,?,?,?)`).bind(
      issue.delegationId,
      issue.scope.target.type,
      issue.scope.target.id,
      issue.targetModelKey,
      issue.scope.maxAccess,
    ),
  ]);
}

export function delegationIssueDtos(
  principal: Principal,
  spaceId: string,
  issues: readonly PreparedDelegationIssue[],
): ReturnType<typeof dto>[] {
  return issues.map((issue) => dto({
    id: issue.delegationId,
    principal_type: principal.type,
    principal_id: principal.id,
    actor_type: issue.actor.type,
    actor_id: issue.actor.id,
    application_id: principal.clientId,
    source_space_id: spaceId,
    parent_delegation_id: issue.parent?.delegation_id ?? null,
    remaining_redelegation_depth: issue.constraints.remainingRedelegationDepth,
    created_by_type: issue.issuer.type,
    created_by_id: issue.issuer.id,
    created_at: issue.createdAt,
    expires_at: issue.constraints.expiresAt,
    revoked_at: null,
    max_uses: issue.constraints.maxUses,
    consumed_at: null,
    target_type: issue.scope.target.type,
    target_id: issue.scope.target.id,
    target_model_key: issue.targetModelKey,
    max_access: issue.scope.maxAccess,
  }));
}

async function commitDelegationIssues(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  issues: readonly PreparedDelegationIssue[],
): Promise<ReturnType<typeof dto>[]> {
  // Cloudflare D1 batch is the atomic commit boundary: all Delegation/scopes are
  // persisted together, or the batch rolls back. Child issuance intentionally
  // does not consume any single-use ancestor.
  await env.DB.batch(delegationIssueStatements(env, principal, spaceId, issues));
  return delegationIssueDtos(principal, spaceId, issues);
}

async function issueDelegations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  values: readonly unknown[],
): Promise<ReturnType<typeof dto>[]> {
  const prepared = await prepareDelegationIssues(env, principal, spaceId, values);
  return commitDelegationIssues(env, principal, spaceId, prepared);
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

export async function loadDelegationDtosByIds(
  env: Bindings,
  delegationIds: readonly string[],
): Promise<ReturnType<typeof dto>[]> {
  if (!delegationIds.length) return [];
  const placeholders = delegationIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`${selectRowsSql()} WHERE d.id IN (${placeholders})`)
    .bind(...delegationIds).all<DelegationRow>();
  const byId = new Map(rows.results.map((row) => [row.id, dto(row)]));
  return delegationIds.flatMap((delegationId) => {
    const item = byId.get(delegationId);
    return item ? [item] : [];
  });
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
    const [created] = await issueDelegations(
      context.env,
      principal,
      context.req.param("spaceId"),
      [body],
    );
    return context.json(success(created!), 201);
  });

  app.post("/api/v1/spaces/:spaceId/delegations/batch", async (context) => {
    const principal = context.get("principal");
    const body = await context.req.json<CreateDelegationBatchBody>().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError("INVALID_REQUEST", "Request body must be a JSON object", 400);
    }
    const unknown = Object.keys(body).find((key) => key !== "items");
    if (unknown) throw new ApiError("INVALID_REQUEST", `Unsupported field ${unknown}`, 400);
    if (!Array.isArray(body.items)
        || body.items.length < 1
        || body.items.length > MAX_ATOMIC_DELEGATION_ISSUES) {
      throw new ApiError(
        "INVALID_REQUEST",
        `items must contain between 1 and ${MAX_ATOMIC_DELEGATION_ISSUES} Delegation specs`,
        400,
      );
    }

    const created = await issueDelegations(
      context.env,
      principal,
      context.req.param("spaceId"),
      body.items,
    );
    return context.json(success({ items: created }), 201);
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

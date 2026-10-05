from pathlib import Path
import re

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text()

def write(path, content):
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)

def replace_once(path, old, new):
    s = read(path)
    if old not in s:
        raise SystemExit(f'missing marker in {path}: {old[:120]!r}')
    if s.count(old) != 1:
        raise SystemExit(f'non-unique marker in {path}: {old[:120]!r} count={s.count(old)}')
    write(path, s.replace(old, new, 1))

# ---------------------------------------------------------------------------
# Schema 50: durable non-atomic Bulk correlation without pretending it is a ChangeSet.
# ---------------------------------------------------------------------------
write('apps/core/migrations/0050_non_atomic_bulk.sql', r'''-- #309: first-class non-atomic Bulk CRUD correlation.
--
-- A Bulk request is a transport/performance grouping with independent item outcomes.
-- It is deliberately not an atomic ChangeSet. Successful items remain ordinary
-- governed Changes; failed items create no Change or Domain Event.

CREATE TABLE resource_bulk_requests (
  id TEXT PRIMARY KEY CHECK(id GLOB 'blk_*'),
  space_id TEXT NOT NULL REFERENCES spaces(id),
  application_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 20),
  succeeded_count INTEGER CHECK(succeeded_count IS NULL OR succeeded_count BETWEEN 0 AND operation_count),
  failed_count INTEGER CHECK(failed_count IS NULL OR failed_count BETWEEN 0 AND operation_count),
  occurred_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK(
    completed_at IS NULL
    OR (succeeded_count IS NOT NULL AND failed_count IS NOT NULL AND succeeded_count + failed_count = operation_count)
  )
);

CREATE INDEX idx_resource_bulk_requests_space_time
  ON resource_bulk_requests(space_id,occurred_at DESC,id DESC);

ALTER TABLE resource_changes
  ADD COLUMN bulk_id TEXT CHECK(bulk_id IS NULL OR bulk_id GLOB 'blk_*');
CREATE INDEX idx_resource_changes_bulk
  ON resource_changes(bulk_id,occurred_at,id) WHERE bulk_id IS NOT NULL;

ALTER TABLE domain_event_outbox
  ADD COLUMN bulk_id TEXT CHECK(bulk_id IS NULL OR bulk_id GLOB 'blk_*');
CREATE INDEX idx_domain_event_outbox_bulk
  ON domain_event_outbox(bulk_id,occurred_at,id) WHERE bulk_id IS NOT NULL;

CREATE TRIGGER trg_resource_change_one_grouping
BEFORE INSERT ON resource_changes
WHEN NEW.change_set_id IS NOT NULL AND NEW.bulk_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'CHANGE_GROUPING_CONFLICT');
END;

CREATE TRIGGER trg_domain_event_one_grouping
BEFORE UPDATE OF change_set_id,bulk_id ON domain_event_outbox
WHEN NEW.change_set_id IS NOT NULL AND NEW.bulk_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'EVENT_GROUPING_CONFLICT');
END;

UPDATE schema_metadata SET value='50' WHERE key='schema_version';
''')

# ---------------------------------------------------------------------------
# Generic mutation attribution gains an independent Bulk identity.
# ---------------------------------------------------------------------------
replace_once('apps/core/src/generic-resource.ts',
'''export type MutationAttribution = {
  delegationId?: string | null;
  delegationChain?: readonly string[];
  changeSetId?: string | null;
};''',
'''export type MutationAttribution = {
  delegationId?: string | null;
  delegationChain?: readonly string[];
  changeSetId?: string | null;
  bulkId?: string | null;
};''')

replace_once('apps/core/src/generic-resource.ts',
'''    attribution.delegationId ?? null,
    attribution.changeSetId ?? null,
    JSON.stringify([...new Set(changedFields)].sort()),''',
'''    attribution.delegationId ?? null,
    attribution.changeSetId ?? null,
    attribution.bulkId ?? null,
    JSON.stringify([...new Set(changedFields)].sort()),''')

replace_once('apps/core/src/generic-resource.ts',
'''      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,
      changed_fields_json,field_changes_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...values);''',
'''      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,bulk_id,
      changed_fields_json,field_changes_json,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...values);''')

replace_once('apps/core/src/generic-resource.ts',
'''      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,
      changed_fields_json,field_changes_json,occurred_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)''',
'''      principal_type,principal_id,actor_type,actor_id,application_id,delegation_id,change_set_id,bulk_id,
      changed_fields_json,field_changes_json,occurred_at
    ) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM resource_records WHERE id=? AND mutation_token=?)`)''')

replace_once('apps/core/src/generic-resource.ts',
'''function appendChangeSetOutboxLink(
  statements: D1PreparedStatement[],
  env: Bindings,
  changeId: string,
  attribution: MutationAttribution,
): void {
  if (!attribution.changeSetId) return;
  statements.push(env.DB.prepare(`UPDATE domain_event_outbox
    SET change_set_id=?
    WHERE change_id=? AND change_set_id IS NULL`)
    .bind(attribution.changeSetId, changeId));
}
''',
'''function appendChangeSetOutboxLink(
  statements: D1PreparedStatement[],
  env: Bindings,
  changeId: string,
  attribution: MutationAttribution,
): void {
  if (!attribution.changeSetId) return;
  statements.push(env.DB.prepare(`UPDATE domain_event_outbox
    SET change_set_id=?
    WHERE change_id=? AND change_set_id IS NULL AND bulk_id IS NULL`)
    .bind(attribution.changeSetId, changeId));
}

function appendBulkOutboxLink(
  statements: D1PreparedStatement[],
  env: Bindings,
  changeId: string,
  attribution: MutationAttribution,
): void {
  if (!attribution.bulkId) return;
  statements.push(env.DB.prepare(`UPDATE domain_event_outbox
    SET bulk_id=?
    WHERE change_id=? AND bulk_id IS NULL AND change_set_id IS NULL`)
    .bind(attribution.bulkId, changeId));
}
''')

# create + update each have this exact pair twice.
s = read('apps/core/src/generic-resource.ts')
needle = '''  appendDelegationChainEvidence(statements, env, mutationToken, attribution);
  appendChangeSetOutboxLink(statements, env, mutationToken, attribution);'''
if s.count(needle) != 2:
    raise SystemExit(f'expected 2 create/update outbox pairs, got {s.count(needle)}')
s = s.replace(needle, needle + '\n  appendBulkOutboxLink(statements, env, mutationToken, attribution);')
write('apps/core/src/generic-resource.ts', s)

replace_once('apps/core/src/generic-resource.ts',
'''    ...(attribution.changeSetId
      ? [env.DB.prepare(`UPDATE domain_event_outbox
          SET change_set_id=?
          WHERE change_id=? AND change_set_id IS NULL`)
          .bind(attribution.changeSetId, mutationToken)]
      : []),
    env.DB.prepare(`DELETE FROM resource_relations WHERE source_record_id=?''',
'''    ...(attribution.changeSetId
      ? [env.DB.prepare(`UPDATE domain_event_outbox
          SET change_set_id=?
          WHERE change_id=? AND change_set_id IS NULL AND bulk_id IS NULL`)
          .bind(attribution.changeSetId, mutationToken)]
      : []),
    ...(attribution.bulkId
      ? [env.DB.prepare(`UPDATE domain_event_outbox
          SET bulk_id=?
          WHERE change_id=? AND bulk_id IS NULL AND change_set_id IS NULL`)
          .bind(attribution.bulkId, mutationToken)]
      : []),
    env.DB.prepare(`DELETE FROM resource_relations WHERE source_record_id=?''')

# ---------------------------------------------------------------------------
# Set-wise per-item authority evaluation. Existing requireModelAccessMany keeps
# fail-fast semantics by wrapping this evaluator.
# ---------------------------------------------------------------------------
replace_once('apps/core/src/model-authorization.ts',
'''export type ModelAccessDecision = {
  principal: Principal;
  authority: ModelAuthorityDecision;
  policyIdentity: ModelPolicyIdentity;
};''',
'''export type ModelAccessDecision = {
  principal: Principal;
  authority: ModelAuthorityDecision;
  policyIdentity: ModelPolicyIdentity;
};

export type ModelAccessEvaluation =
  | { ok: true; decision: ModelAccessDecision }
  | { ok: false; error: ApiError };''')

old = '''async function requireModelAccessManyResolved(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
  preloadedChains: Map<string, DelegationChainRow[]> | null = null,
): Promise<ModelAccessDecision[]> {
  if (!requests.length) return [];

  const prepared = requests.map((request) => prepareAccess(principal, spaceId, request));
  const baseEntries = new Map<string, PreparedBaseAuthority>();
  const leafIds = new Set<string>();

  for (const entry of prepared) {
    if (!baseEntries.has(entry.baseKey)) {
      baseEntries.set(entry.baseKey, {
        key: entry.baseKey,
        model: entry.request.model,
        statement: baseAuthorityStatement(env, principal, spaceId, entry.request.model),
      });
    }
    if (entry.delegationId) leafIds.add(entry.delegationId);
  }

  const uniqueBases = [...baseEntries.values()];
  const uniqueLeafIds = [...leafIds];
  const shouldLoadChains = preloadedChains === null && uniqueLeafIds.length > 0;
  const statements = [
    ...uniqueBases.map((entry) => entry.statement),
    ...(shouldLoadChains ? [delegationChainStatement(env, uniqueLeafIds)] : []),
  ];
  const results = await env.DB.batch<Record<string, unknown>>(statements);

  const baseRows = new Map<string, BaseAuthoritySnapshotRow | null>();
  uniqueBases.forEach((entry, index) => {
    const row = (results[index]?.results ?? [])[0] as BaseAuthoritySnapshotRow | undefined;
    baseRows.set(entry.key, row ?? null);
  });

  const chainsByLeaf = preloadedChains ?? (shouldLoadChains
    ? groupDelegationChainRows(
        (results[uniqueBases.length]?.results ?? []) as DelegationChainRow[],
      )
    : new Map<string, DelegationChainRow[]>());

  return prepared.map((entry) => decisionFromSnapshots(
    principal,
    spaceId,
    entry,
    baseRows.get(entry.baseKey) ?? null,
    entry.delegationId ? chainsByLeaf.get(entry.delegationId) ?? [] : [],
  ));
}
'''
new = '''function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  throw error;
}

async function evaluateModelAccessManyResolved(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
  preloadedChains: Map<string, DelegationChainRow[]> | null = null,
): Promise<ModelAccessEvaluation[]> {
  if (!requests.length) return [];

  const prepared = requests.map((request) => {
    try {
      return { ok: true as const, value: prepareAccess(principal, spaceId, request) };
    } catch (error) {
      return { ok: false as const, error: asApiError(error) };
    }
  });
  const baseEntries = new Map<string, PreparedBaseAuthority>();
  const leafIds = new Set<string>();

  for (const result of prepared) {
    if (!result.ok) continue;
    const entry = result.value;
    if (!baseEntries.has(entry.baseKey)) {
      baseEntries.set(entry.baseKey, {
        key: entry.baseKey,
        model: entry.request.model,
        statement: baseAuthorityStatement(env, principal, spaceId, entry.request.model),
      });
    }
    if (entry.delegationId) leafIds.add(entry.delegationId);
  }

  const uniqueBases = [...baseEntries.values()];
  const uniqueLeafIds = [...leafIds];
  const shouldLoadChains = preloadedChains === null && uniqueLeafIds.length > 0;
  const statements = [
    ...uniqueBases.map((entry) => entry.statement),
    ...(shouldLoadChains ? [delegationChainStatement(env, uniqueLeafIds)] : []),
  ];
  const results = statements.length
    ? await env.DB.batch<Record<string, unknown>>(statements)
    : [];

  const baseRows = new Map<string, BaseAuthoritySnapshotRow | null>();
  uniqueBases.forEach((entry, index) => {
    const row = (results[index]?.results ?? [])[0] as BaseAuthoritySnapshotRow | undefined;
    baseRows.set(entry.key, row ?? null);
  });

  const chainsByLeaf = preloadedChains ?? (shouldLoadChains
    ? groupDelegationChainRows(
        (results[uniqueBases.length]?.results ?? []) as DelegationChainRow[],
      )
    : new Map<string, DelegationChainRow[]>());

  return prepared.map((result) => {
    if (!result.ok) return { ok: false as const, error: result.error };
    const entry = result.value;
    try {
      return {
        ok: true as const,
        decision: decisionFromSnapshots(
          principal,
          spaceId,
          entry,
          baseRows.get(entry.baseKey) ?? null,
          entry.delegationId ? chainsByLeaf.get(entry.delegationId) ?? [] : [],
        ),
      };
    } catch (error) {
      return { ok: false as const, error: asApiError(error) };
    }
  });
}

async function requireModelAccessManyResolved(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
  preloadedChains: Map<string, DelegationChainRow[]> | null = null,
): Promise<ModelAccessDecision[]> {
  const evaluated = await evaluateModelAccessManyResolved(env, principal, spaceId, requests, preloadedChains);
  return evaluated.map((entry) => {
    if (!entry.ok) throw entry.error;
    return entry.decision;
  });
}
'''
replace_once('apps/core/src/model-authorization.ts', old, new)

marker = '''export async function requireModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessDecision[]> {'''
if marker not in read('apps/core/src/model-authorization.ts'):
    raise SystemExit('requireModelAccessMany marker missing')

evaluator = r'''export async function evaluateModelAccessMany(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  requests: readonly ModelAccessRequest[],
): Promise<ModelAccessEvaluation[]> {
  if (!requests.length) return [];

  const agentApiCredential = principal.type === "agent" && !principal.actor && principal.purpose === "agent_api";
  if (!agentApiCredential) return evaluateModelAccessManyResolved(env, principal, spaceId, requests);

  const delegationIds = requests.map((request) => request.selector?.delegationId?.trim() || null);
  const selected = delegationIds.filter((value): value is string => Boolean(value));
  if (!selected.length) return evaluateModelAccessManyResolved(env, principal, spaceId, requests);
  if (selected.length !== delegationIds.length) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "One Agent API credential Bulk cannot mix direct Agent authority and represented Delegation authority",
      403,
    );
  }

  const uniqueLeafIds = [...new Set(selected)];
  const [result] = await env.DB.batch<Record<string, unknown>>([
    delegationChainStatement(env, uniqueLeafIds),
  ]);
  const chainsByLeaf = groupDelegationChainRows((result?.results ?? []) as DelegationChainRow[]);
  const resolved = selected.map((delegationId) => {
    try {
      return { ok: true as const, principal: resolveAgentApiDelegatedPrincipal(
        principal,
        spaceId,
        delegationId,
        chainsByLeaf.get(delegationId) ?? [],
      ) };
    } catch (error) {
      return { ok: false as const, error: asApiError(error) };
    }
  });
  const valid = resolved.filter((entry): entry is Extract<typeof entry, { ok: true }> => entry.ok);
  if (!valid.length) {
    return resolved.map((entry) => entry.ok
      ? { ok: false as const, error: new ApiError("DELEGATION_INVALID", "Delegation could not resolve a Root Principal", 403) }
      : { ok: false as const, error: entry.error });
  }
  const first = valid[0]!.principal;
  if (valid.some((entry) => entry.principal.type !== first.type || entry.principal.id !== first.id || entry.principal.actor?.id !== first.actor?.id)) {
    throw new ApiError(
      "DELEGATION_INVALID",
      "One Agent API credential Bulk must resolve to one Root Principal",
      403,
    );
  }

  const validIndexes = resolved.flatMap((entry, index) => entry.ok ? [index] : []);
  const evaluatedValid = await evaluateModelAccessManyResolved(
    env,
    first,
    spaceId,
    validIndexes.map((index) => requests[index]!),
    chainsByLeaf,
  );
  const byIndex = new Map(validIndexes.map((index, offset) => [index, evaluatedValid[offset]!]));
  return resolved.map((entry, index) => entry.ok
    ? byIndex.get(index)!
    : { ok: false as const, error: entry.error });
}

'''
replace_once('apps/core/src/model-authorization.ts', marker, evaluator + marker)

# ---------------------------------------------------------------------------
# Set-wise relation validation with per-item diagnostics.
# ---------------------------------------------------------------------------
old_rel = '''export async function validateRelationProjections(
  env: Bindings,
  spaceId: string,
  relations: readonly RelationProjection[],
): Promise<void> {
  const personIds = new Set(
    relations.filter((relation) => relation.targetType === "person").map((relation) => relation.targetId),
  );
  const recordIdsByModel = new Map<string, Set<string>>();
  for (const relation of relations) {
    if (relation.targetType !== "record") continue;
    if (!relation.targetModelKey) {
      throw new ApiError("INVALID_RESOURCE_RELATION", "Record relation is missing its target model", 500);
    }
    const ids = recordIdsByModel.get(relation.targetModelKey) ?? new Set<string>();
    ids.add(relation.targetId);
    recordIdsByModel.set(relation.targetModelKey, ids);
  }

  const validations: Array<{
    expected: Set<string>;
    statements: D1PreparedStatement[];
    message: string;
  }> = [];

  if (personIds.size) {
    validations.push({
      expected: personIds,
      statements: chunkD1Values([...personIds], 1).map((chunk) =>
        env.DB.prepare(`SELECT id FROM space_people
          WHERE space_id=? AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(spaceId, ...chunk),
      ),
      message: "Every Person relation must reference an active Person in the same Space",
    });
  }

  for (const [targetModel, ids] of recordIdsByModel) {
    validations.push({
      expected: ids,
      statements: chunkD1Values([...ids], 2).map((chunk) =>
        env.DB.prepare(`SELECT id FROM resource_records
          WHERE space_id=? AND model_key=? AND deleted_at IS NULL
            AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(spaceId, targetModel, ...chunk),
      ),
      message: `Every record relation must reference an active ${targetModel} record in the same Space`,
    });
  }

  const statements = validations.flatMap((validation) => validation.statements);
  if (!statements.length) return;

  const results = await env.DB.batch<{ id: string }>(statements);
  let offset = 0;
  for (const validation of validations) {
    const found = new Set<string>();
    for (let index = 0; index < validation.statements.length; index += 1) {
      for (const row of results[offset + index]?.results ?? []) found.add(row.id);
    }
    offset += validation.statements.length;
    if (found.size !== validation.expected.size) {
      throw new ApiError("INVALID_RESOURCE_RELATION", validation.message, 400);
    }
  }
}
'''
new_rel = '''export async function validateRelationProjectionGroups(
  env: Bindings,
  spaceId: string,
  groups: readonly (readonly RelationProjection[])[],
): Promise<Array<ApiError | null>> {
  const personIds = new Set<string>();
  const recordIdsByModel = new Map<string, Set<string>>();
  for (const relations of groups) {
    for (const relation of relations) {
      if (relation.targetType === "person") {
        personIds.add(relation.targetId);
        continue;
      }
      if (!relation.targetModelKey) {
        return groups.map((group) => group.some((entry) => entry === relation)
          ? new ApiError("INVALID_RESOURCE_RELATION", "Record relation is missing its target model", 500)
          : null);
      }
      const ids = recordIdsByModel.get(relation.targetModelKey) ?? new Set<string>();
      ids.add(relation.targetId);
      recordIdsByModel.set(relation.targetModelKey, ids);
    }
  }

  const queries: Array<{ kind: "person" | "record"; modelKey?: string; statements: D1PreparedStatement[] }> = [];
  if (personIds.size) {
    queries.push({
      kind: "person",
      statements: chunkD1Values([...personIds], 1).map((chunk) =>
        env.DB.prepare(`SELECT id FROM space_people
          WHERE space_id=? AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(spaceId, ...chunk),
      ),
    });
  }
  for (const [targetModel, ids] of recordIdsByModel) {
    queries.push({
      kind: "record",
      modelKey: targetModel,
      statements: chunkD1Values([...ids], 2).map((chunk) =>
        env.DB.prepare(`SELECT id FROM resource_records
          WHERE space_id=? AND model_key=? AND deleted_at IS NULL
            AND id IN (${chunk.map(() => "?").join(",")})`)
          .bind(spaceId, targetModel, ...chunk),
      ),
    });
  }
  const statements = queries.flatMap((query) => query.statements);
  if (!statements.length) return groups.map(() => null);
  const results = await env.DB.batch<{ id: string }>(statements);
  const foundPeople = new Set<string>();
  const foundRecords = new Map<string, Set<string>>();
  let offset = 0;
  for (const query of queries) {
    const found = new Set<string>();
    for (let index = 0; index < query.statements.length; index += 1) {
      for (const row of results[offset + index]?.results ?? []) found.add(row.id);
    }
    offset += query.statements.length;
    if (query.kind === "person") for (const id of found) foundPeople.add(id);
    else foundRecords.set(query.modelKey!, found);
  }

  return groups.map((relations) => {
    for (const relation of relations) {
      if (relation.targetType === "person" && !foundPeople.has(relation.targetId)) {
        return new ApiError("INVALID_RESOURCE_RELATION", "Every Person relation must reference an active Person in the same Space", 400);
      }
      if (relation.targetType === "record" && !foundRecords.get(relation.targetModelKey!)?.has(relation.targetId)) {
        return new ApiError("INVALID_RESOURCE_RELATION", `Every record relation must reference an active ${relation.targetModelKey} record in the same Space`, 400);
      }
    }
    return null;
  });
}

export async function validateRelationProjections(
  env: Bindings,
  spaceId: string,
  relations: readonly RelationProjection[],
): Promise<void> {
  const [error] = await validateRelationProjectionGroups(env, spaceId, [relations]);
  if (error) throw error;
}
'''
replace_once('apps/core/src/generic-resource.ts', old_rel, new_rel)

# ---------------------------------------------------------------------------
# First-class non-atomic Bulk route.
# ---------------------------------------------------------------------------
write('apps/core/src/generic-bulk-routes.ts', r'''import type { Context, Hono } from "hono";
import {
  hasTemporalCapability,
  prepareCapabilityCreateInput,
  prepareCapabilityCreateMutation,
  prepareCapabilityUpdateMutation,
} from "./capability-runtime";
import type { Bindings, Principal, Variables } from "./env";
import {
  planCreateGenericMutation,
  planDeleteGenericMutation,
  planUpdateGenericMutation,
  prepareCreateGenericMutation,
  prepareUpdateGenericMutation,
  validateRelationProjectionGroups,
  type GenericResource,
  type PreparedCreateMutation,
  type PreparedUpdateMutation,
  type ResourceMutationExtension,
  type ResourceMutationPlan,
} from "./generic-resource";
import { ApiError, success } from "./http";
import {
  evaluateModelAccessMany,
  type ModelAccessDecision,
  type ModelAccessRequest,
} from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { requireModelPolicy } from "./policy";
import { loadSpaceTemporalContext, type SpaceTemporalContext } from "./temporal-capability";
import { getTypedResourcesByModels } from "./typed-resource-batch";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;
type OperationKind = "create" | "update" | "delete";
type BulkOperation = {
  operation: OperationKind;
  modelKey: string;
  recordId: string | null;
  version: number | null;
  data: Record<string, unknown> | null;
  delegationId: string | null;
};
type PreparedBulkItem = {
  index: number;
  operation: BulkOperation;
  model: PublishedModel;
  decision: ModelAccessDecision;
  previous: GenericResource | null;
  preparedCreate?: PreparedCreateMutation;
  preparedUpdate?: PreparedUpdateMutation;
  extension?: ResourceMutationExtension;
};
type BulkError = { code: string; message: string; status: number };
type ItemState = {
  index: number;
  raw: unknown;
  operation?: BulkOperation;
  model?: PublishedModel;
  decision?: ModelAccessDecision;
  previous?: GenericResource | null;
  prepared?: PreparedBulkItem;
  plan?: ResourceMutationPlan;
  error?: ApiError;
};

const MAX_BULK_OPERATIONS = 20;
const modelKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,99}$/u;
const recordIdPattern = /^rec_[A-Za-z0-9_-]+$/u;
const delegationIdPattern = /^dlg_[A-Za-z0-9_-]+$/u;

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("INVALID_REQUEST", message, 400);
  return value as Record<string, unknown>;
}
function optionalPositiveVersion(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || Number(value) < 1) throw new ApiError("INVALID_REQUEST", "Bulk operation version must be a positive integer when supplied", 400);
  return Number(value);
}
function optionalDelegationId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !delegationIdPattern.test(value)) throw new ApiError("INVALID_REQUEST", "delegationId must be a valid dlg_* identifier", 400);
  return value;
}
function parseOperation(value: unknown, index: number): BulkOperation {
  const input = object(value, `Bulk operation ${index} must be an object`);
  const operation = input.operation;
  if (operation !== "create" && operation !== "update" && operation !== "delete") throw new ApiError("INVALID_REQUEST", `Bulk operation ${index} has an unsupported operation`, 400);
  if (typeof input.modelKey !== "string" || !modelKeyPattern.test(input.modelKey)) throw new ApiError("INVALID_REQUEST", `Bulk operation ${index} has an invalid modelKey`, 400);
  const delegationId = optionalDelegationId(input.delegationId);
  if (operation === "create") {
    const allowed = new Set(["operation", "modelKey", "data", "delegationId"]);
    const extra = Object.keys(input).find((key) => !allowed.has(key));
    if (extra) throw new ApiError("INVALID_REQUEST", `Bulk create ${index} does not allow ${extra}`, 400);
    return { operation, modelKey: input.modelKey, recordId: null, version: null, data: object(input.data, `Bulk create ${index} data must be an object`), delegationId };
  }
  if (typeof input.recordId !== "string" || !recordIdPattern.test(input.recordId)) throw new ApiError("INVALID_REQUEST", `Bulk operation ${index} has an invalid recordId`, 400);
  const version = optionalPositiveVersion(input.version);
  if (operation === "delete") {
    const allowed = new Set(["operation", "modelKey", "recordId", "version", "delegationId"]);
    const extra = Object.keys(input).find((key) => !allowed.has(key));
    if (extra) throw new ApiError("INVALID_REQUEST", `Bulk delete ${index} does not allow ${extra}`, 400);
    return { operation, modelKey: input.modelKey, recordId: input.recordId, version, data: null, delegationId };
  }
  const allowed = new Set(["operation", "modelKey", "recordId", "version", "data", "delegationId"]);
  const extra = Object.keys(input).find((key) => !allowed.has(key));
  if (extra) throw new ApiError("INVALID_REQUEST", `Bulk update ${index} does not allow ${extra}`, 400);
  const data = object(input.data, `Bulk update ${index} data must be an object`);
  if (!Object.keys(data).length) throw new ApiError("INVALID_REQUEST", `Bulk update ${index} requires at least one field change`, 400);
  return { operation, modelKey: input.modelKey, recordId: input.recordId, version, data, delegationId };
}
function parseEnvelope(value: unknown): unknown[] {
  const input = object(value, "Bulk body must be an object");
  if (Object.keys(input).some((key) => key !== "operations")) throw new ApiError("INVALID_REQUEST", "Bulk body accepts only operations", 400);
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > MAX_BULK_OPERATIONS) throw new ApiError("INVALID_REQUEST", `operations must contain 1-${MAX_BULK_OPERATIONS} items`, 400);
  return input.operations;
}
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  throw error;
}
function errorDto(error: ApiError): BulkError { return { code: error.code, message: error.message, status: error.status }; }
function actor(principal: Principal) { return principal.actor ?? { type: principal.type, id: principal.id }; }

async function loadExistingResources(env: Bindings, spaceId: string, items: readonly ItemState[]): Promise<Map<string, GenericResource>> {
  const idsByModel = new Map<string, { model: PublishedModel; ids: string[] }>();
  for (const item of items) {
    if (item.error || !item.operation?.recordId || !item.model) continue;
    const group = idsByModel.get(item.model.key) ?? { model: item.model, ids: [] };
    group.ids.push(item.operation.recordId);
    idsByModel.set(item.model.key, group);
  }
  if (!idsByModel.size) return new Map();
  return getTypedResourcesByModels(env, spaceId, [...idsByModel.values()]);
}

async function prepareItems(env: Bindings, principal: Principal, spaceId: string, items: ItemState[]): Promise<void> {
  const needsTemporal = items.some((item) => !item.error && item.operation?.operation === "create" && item.model && hasTemporalCapability(item.model));
  const temporalContext: SpaceTemporalContext | undefined = needsTemporal ? await loadSpaceTemporalContext(env, spaceId) : undefined;
  for (const item of items) {
    if (item.error || !item.operation || !item.model || !item.decision) continue;
    try {
      const operation = item.operation;
      const model = item.model;
      const decision = item.decision;
      if (operation.operation === "create") {
        const policyInput = prepareCapabilityCreateInput(model, operation.data!);
        await requireModelPolicy(env, principal, spaceId, model, "create", undefined, policyInput, { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId });
        const capability = await prepareCapabilityCreateMutation(env, spaceId, model, operation.data!, undefined, temporalContext);
        item.prepared = { index: item.index, operation, model, decision, previous: null, preparedCreate: prepareCreateGenericMutation(model, capability.prepared, capability.trusted), extension: capability.extension };
        continue;
      }
      const previous = item.previous;
      if (!previous || previous.modelKey !== model.key) throw new ApiError("RESOURCE_NOT_FOUND", `Bulk target ${operation.recordId} was not found in model ${model.key}`, 404);
      if (operation.version !== null && operation.version !== previous.version) throw new ApiError("VERSION_CONFLICT", "Resource version is stale", 409);
      if (operation.operation === "delete") {
        await requireModelPolicy(env, principal, spaceId, model, "delete", previous, undefined, { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId });
        item.prepared = { index: item.index, operation, model, decision, previous };
        continue;
      }
      const preparedInput = prepareCapabilityUpdateMutation(model, previous, operation.data!);
      await requireModelPolicy(env, principal, spaceId, model, "update", previous, preparedInput, { principalPersonId: decision.policyIdentity.principalPersonId, actorPersonId: decision.policyIdentity.actorPersonId });
      item.prepared = { index: item.index, operation, model, decision, previous, preparedUpdate: prepareUpdateGenericMutation(model, preparedInput, previous, "client") };
    } catch (error) {
      item.error = asApiError(error);
    }
  }
}

async function buildPlan(env: Bindings, principal: Principal, spaceId: string, entry: PreparedBulkItem, bulkId: string, timestamp: string): Promise<ResourceMutationPlan> {
  const attribution = { delegationId: entry.decision.authority.delegationId, delegationChain: entry.decision.authority.delegationChain, bulkId };
  if (entry.operation.operation === "create") return planCreateGenericMutation(env, principal, spaceId, entry.model, entry.preparedCreate!, entry.extension, attribution, timestamp);
  if (entry.operation.operation === "update") return planUpdateGenericMutation(env, principal, spaceId, entry.model, entry.previous!, entry.operation.version ?? entry.previous!.version, entry.preparedUpdate!, "client", undefined, undefined, attribution, timestamp);
  return planDeleteGenericMutation(env, principal, spaceId, entry.model, entry.previous!, entry.operation.version ?? entry.previous!.version, attribution, timestamp);
}

function singleUseFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE");
}
function commitRaceError(): ApiError { return new ApiError("VERSION_CONFLICT", "Bulk item target changed concurrently before commit", 409); }
function delegationRaceError(): ApiError { return new ApiError("DELEGATION_INVALID", "Single-use Delegation was consumed, revoked or expired before Bulk item commit", 403); }

async function finalizeBulk(env: Bindings, bulkId: string, timestamp: string): Promise<void> {
  await env.DB.prepare(`UPDATE resource_bulk_requests
    SET succeeded_count=(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
        failed_count=operation_count-(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
        completed_at=?
    WHERE id=? AND completed_at IS NULL`)
    .bind(bulkId, bulkId, timestamp, bulkId).run();
}

async function commitIndependently(env: Bindings, bulkId: string, plans: ItemState[], timestamp: string): Promise<void> {
  await env.DB.prepare(`INSERT INTO resource_bulk_requests(
    id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at
  ) SELECT ?,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at
    FROM resource_bulk_requests WHERE 0`).run().catch(() => undefined);
  for (const item of plans) {
    if (!item.plan || item.error) continue;
    try {
      const results = await env.DB.batch(item.plan.statements);
      if (!results[0]?.meta.changes) item.error = commitRaceError();
    } catch (error) {
      if (singleUseFailure(error)) item.error = delegationRaceError();
      else throw error;
    }
  }
  await finalizeBulk(env, bulkId, timestamp);
}

export function registerGenericBulkRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/models/bulk", async (context: Context<AppEnv>) => {
    const authenticated = context.get("principal");
    const spaceId = context.req.param("spaceId");
    if (!spaceId) throw new ApiError("INVALID_REQUEST", "spaceId is required", 400);
    const body = await context.req.json<unknown>().catch(() => null);
    const raw = parseEnvelope(body);
    const items: ItemState[] = raw.map((value, index) => ({ index, raw: value }));

    const seenTargets = new Set<string>();
    for (const item of items) {
      try {
        item.operation = parseOperation(item.raw, item.index);
        if (item.operation.recordId) {
          const key = `${item.operation.modelKey}\u001f${item.operation.recordId}`;
          if (seenTargets.has(key)) throw new ApiError("INVALID_REQUEST", "One existing record may appear at most once in a Bulk", 400);
          seenTargets.add(key);
        }
      } catch (error) { item.error = asApiError(error); }
    }

    for (const item of items) {
      if (item.error || !item.operation) continue;
      const model = await getRuntimeModel(context.env, item.operation.modelKey);
      if (!model) item.error = new ApiError("MODEL_NOT_FOUND", `Published model ${item.operation.modelKey} not found`, 404);
      else item.model = model;
    }

    const candidates = items.filter((item) => !item.error && item.operation && item.model);
    const requests: ModelAccessRequest[] = candidates.map((item) => ({ model: item.model!, required: "write", selector: { delegationId: item.operation!.delegationId, ...(item.operation!.recordId ? { recordId: item.operation!.recordId } : {}) } }));
    const evaluations = await evaluateModelAccessMany(context.env, authenticated, spaceId, requests);
    evaluations.forEach((evaluation, offset) => {
      const item = candidates[offset]!;
      if (evaluation.ok) item.decision = evaluation.decision;
      else item.error = evaluation.error;
    });

    const validDecisions = items.filter((item) => !item.error && item.decision).map((item) => item.decision!);
    const executionPrincipal = validDecisions[0]?.principal ?? authenticated;
    if (validDecisions.some((decision) => decision.principal.type !== executionPrincipal.type || decision.principal.id !== executionPrincipal.id || decision.principal.actor?.type !== executionPrincipal.actor?.type || decision.principal.actor?.id !== executionPrincipal.actor?.id)) {
      throw new ApiError("DELEGATION_INVALID", "Bulk operations must resolve to one Execution Principal", 403);
    }

    const previousById = await loadExistingResources(context.env, spaceId, items);
    for (const item of items) if (!item.error && item.operation?.recordId) item.previous = previousById.get(item.operation.recordId) ?? null;
    await prepareItems(context.env, executionPrincipal, spaceId, items);

    const preparedItems = items.filter((item) => !item.error && item.prepared);
    const relationGroups = preparedItems.map((item) => [
      ...(item.prepared!.preparedCreate?.relations ?? []),
      ...(item.prepared!.preparedUpdate?.relations ?? []),
    ]);
    const relationErrors = await validateRelationProjectionGroups(context.env, spaceId, relationGroups);
    relationErrors.forEach((error, offset) => { if (error) preparedItems[offset]!.error = error; });

    const bulkId = `blk_${crypto.randomUUID().replaceAll("-", "")}`;
    const timestamp = new Date().toISOString();
    for (const item of items) {
      if (item.error || !item.prepared) continue;
      item.plan = await buildPlan(context.env, executionPrincipal, spaceId, item.prepared, bulkId, timestamp);
    }
    const planned = items.filter((item) => item.plan && !item.error);
    const executedBy = actor(executionPrincipal);
    const insertBulk = context.env.DB.prepare(`INSERT INTO resource_bulk_requests(
      id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).bind(
      bulkId, spaceId, executionPrincipal.clientId, executionPrincipal.type, executionPrincipal.id,
      executedBy.type, executedBy.id, items.length, timestamp,
    );
    const finalize = context.env.DB.prepare(`UPDATE resource_bulk_requests
      SET succeeded_count=(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
          failed_count=operation_count-(SELECT COUNT(*) FROM resource_changes WHERE bulk_id=?),
          completed_at=?
      WHERE id=? AND completed_at IS NULL`).bind(bulkId, bulkId, timestamp, bulkId);
    const statements: D1PreparedStatement[] = [insertBulk];
    const firstStatementIndexes = new Map<number, number>();
    for (const item of planned) {
      firstStatementIndexes.set(item.index, statements.length);
      statements.push(...item.plan!.statements);
    }
    statements.push(finalize);

    try {
      const results = await context.env.DB.batch(statements);
      for (const item of planned) {
        const firstResult = results[firstStatementIndexes.get(item.index)!];
        if (!firstResult?.meta.changes) item.error = commitRaceError();
      }
    } catch (error) {
      if (!singleUseFailure(error)) throw error;
      // The grouped D1 transaction was rolled back. Recreate the durable Bulk row,
      // then replay only surviving items independently. This bounded contention
      // slow path preserves partial success without making the normal path N RTTs.
      await context.env.DB.batch([insertBulk]);
      await commitIndependently(context.env, bulkId, planned, timestamp);
    }

    return context.json(success({
      bulkId,
      items: items.map((item) => {
        const operation = item.operation?.operation ?? (typeof (item.raw as any)?.operation === "string" ? (item.raw as any).operation : null);
        const modelKey = item.operation?.modelKey ?? (typeof (item.raw as any)?.modelKey === "string" ? (item.raw as any).modelKey : null);
        if (item.error || !item.plan) return { index: item.index, operation, modelKey, status: "failed", error: errorDto(item.error ?? new ApiError("INVALID_REQUEST", "Bulk item could not be prepared", 400)) };
        const version = item.plan.resource?.version ?? (item.prepared!.previous!.version + 1);
        return { index: item.index, operation: item.operation!.operation, modelKey: item.operation!.modelKey, status: "succeeded", recordId: item.plan.resource?.id ?? item.operation!.recordId!, version };
      }),
    }));
  });
}
''')

replace_once('apps/core/src/app.ts',
'''import { registerGenericBatchRoutes } from "./generic-batch-routes";''',
'''import { registerGenericBatchRoutes } from "./generic-batch-routes";
import { registerGenericBulkRoutes } from "./generic-bulk-routes";''')
replace_once('apps/core/src/app.ts',
'''  registerGenericBatchRoutes(app);
  registerGenericResourceRoutes(app);''',
'''  registerGenericBatchRoutes(app);
  registerGenericBulkRoutes(app);
  registerGenericResourceRoutes(app);''')

# ---------------------------------------------------------------------------
# Model Contract: independent Bulk syntax; existing atomic Batch unchanged.
# ---------------------------------------------------------------------------
replace_once('apps/core/src/model-contract.ts',
'''  schemas.BatchMutationResponse = {
    type: "object",''',
'''  schemas.BulkMutationResultItem = {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["index", "operation", "modelKey", "status", "recordId", "version"],
        properties: {
          index: { type: "integer", minimum: 0, maximum: 19 },
          operation: { type: "string", enum: ["create", "update", "delete"] },
          modelKey: { type: "string", enum: models.map((model) => model.key) },
          status: { const: "succeeded" },
          recordId: { type: "string", pattern: "^rec_[A-Za-z0-9_-]+$" },
          version: { type: "integer", minimum: 1 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["index", "status", "error"],
        properties: {
          index: { type: "integer", minimum: 0, maximum: 19 },
          operation: { anyOf: [{ type: "string", enum: ["create", "update", "delete"] }, { type: "null" }] },
          modelKey: { anyOf: [{ type: "string" }, { type: "null" }] },
          status: { const: "failed" },
          error: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "status"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              status: { type: "integer", minimum: 400, maximum: 599 },
            },
          },
        },
      },
    ],
  };
  schemas.BulkMutationRequest = {
    type: "object",
    additionalProperties: false,
    required: ["operations"],
    properties: {
      operations: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/BatchOperation" } },
    },
  };
  schemas.BulkMutationResponse = {
    type: "object",
    additionalProperties: false,
    required: ["data"],
    properties: {
      data: {
        type: "object",
        additionalProperties: false,
        required: ["bulkId", "items"],
        properties: {
          bulkId: { type: "string", pattern: "^blk_[A-Za-z0-9_-]+$" },
          items: { type: "array", minItems: 1, maxItems: 20, items: { $ref: "#/components/schemas/BulkMutationResultItem" } },
        },
      },
    },
  };
  schemas.BatchMutationResponse = {
    type: "object",''')

replace_once('apps/core/src/model-contract.ts',
'''  paths["/api/v1/spaces/{spaceId}/models/batch"] = {''',
'''  paths["/api/v1/spaces/{spaceId}/models/bulk"] = {
    parameters: [{ $ref: "#/components/parameters/SpaceId" }],
    post: {
      operationId: "bulk_mutate_models",
      tags: ["Batch"],
      description: "Applies 1-20 create/update/delete operations in one source Space with independent per-item outcomes. Shared execution and Authority work is resolved set-wise; successful items commit ordinary governed Changes correlated by one Bulk ID while failures commit no Change.",
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/BulkMutationRequest" } } } },
      responses: {
        "200": { description: "Bulk completed with independent per-item results", content: { "application/json": { schema: { $ref: "#/components/schemas/BulkMutationResponse" } } } },
        "400": { description: "Invalid Bulk envelope" },
        "403": { description: "Request-level Execution Context inconsistency" },
      },
      "x-lifespace-batch-semantics": {
        atomic: false,
        maxOperations: 20,
        result: "independent-per-item",
        changeEvidence: "one-change-per-success-plus-one-bulk-id",
        authority: "verified-once-and-de-duplicated-by-authority-key",
        concurrency: "per-item-optional-client-version-or-current-set-wise-snapshot",
      },
    },
  };
  paths["/api/v1/spaces/{spaceId}/models/batch"] = {''')

# ---------------------------------------------------------------------------
# Integration tests for partial success and atomic Batch compatibility.
# ---------------------------------------------------------------------------
write('apps/core/test/bulk-runtime.integration.test.ts', r'''import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: "SHA-256" }, true, ["sign","verify"]);
  return { privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)) };
}
async function token(privateKey: string, userId: string, agentId?: string) {
  const iat = Math.floor(Date.now()/1000);
  return sign({ iss:"lifespace-identity", aud:"lifespace-core", sub:agentId ?? userId, azp:"bulk-test-app", principal_type:"user", scope:"resources:read resources:write", iat, exp:iat+900, jti:`tok_${crypto.randomUUID()}`, ...(agentId ? { principal_id:userId, actor_type:"agent", actor_id:agentId, purpose:"agent_execution" } : {}) }, privateKey, "RS256");
}
async function request(publicKey:string, bearer:string, path:string, body:unknown) {
  return createApp().request(`http://localhost${path}`, { method:"POST", headers:{ authorization:`Bearer ${bearer}`, "content-type":"application/json" }, body:JSON.stringify(body) }, { DB:(env as unknown as TestEnv).DB, IDENTITY_PUBLIC_KEY:publicKey, ENVIRONMENT:"test" });
}
async function json(response:Response) { return response.json<any>(); }
async function seed(userId:string, spaceId:string) {
  const db=(env as unknown as TestEnv).DB; const now=new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone) VALUES(?,?,?,?,?,?)").bind(spaceId,"Bulk",userId,now,now,"UTC"),
    db.prepare("INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(`mem_${crypto.randomUUID()}`,spaceId,userId,"owner",now,now),
    db.prepare("INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(`per_${crypto.randomUUID()}`,spaceId,userId,"Owner",now,now),
    db.prepare("INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id) VALUES(?,?,?,?,?) ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access").bind("bulk-test-app","task","write","user",userId),
  ]);
}
async function createTask(publicKey:string,bearer:string,spaceId:string,name:string) {
  const r=await request(publicKey,bearer,`/api/v1/spaces/${spaceId}/models/task/records`,{name,assigneePersonIds:[]}); expect(r.status).toBe(201); return (await json(r)).data;
}
async function delegation(publicKey:string,direct:string,spaceId:string,agentId:string) {
  const r=await request(publicKey,direct,`/api/v1/spaces/${spaceId}/delegations`,{actor:{type:"agent",id:agentId},scope:{target:{type:"model",id:"task"},maxAccess:"write"},constraints:{maxUses:1}}); expect(r.status).toBe(201); return (await json(r)).data.id as string;
}

describe("first-class non-atomic Bulk Runtime",()=>{
  it("keeps successful items when another item is invalid or stale",async()=>{
    const {privateKey,publicKey}=await keys(); const userId=`usr_${crypto.randomUUID().replaceAll("-","")}`; const spaceId=`spc_${crypto.randomUUID().replaceAll("-","")}`; await seed(userId,spaceId); const bearer=await token(privateKey,userId); const target=await createTask(publicKey,bearer,spaceId,"old");
    const response=await request(publicKey,bearer,`/api/v1/spaces/${spaceId}/models/bulk`,{operations:[
      {operation:"create",modelKey:"task",data:{name:"good",assigneePersonIds:[]}},
      {operation:"update",modelKey:"task",recordId:target.id,version:999999,data:{name:"stale"}},
      {operation:"create",modelKey:"missing_model",data:{name:"bad"}},
    ]});
    expect(response.status).toBe(200); const result=(await json(response)).data; expect(result.bulkId).toMatch(/^blk_/); expect(result.items.map((x:any)=>x.status)).toEqual(["succeeded","failed","failed"]); expect(result.items[1].error.code).toBe("VERSION_CONFLICT"); expect(result.items[2].error.code).toBe("MODEL_NOT_FOUND");
    const db=(env as unknown as TestEnv).DB; const changes=await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE bulk_id=?").bind(result.bulkId).first<{count:number}>(); const bulk=await db.prepare("SELECT operation_count,succeeded_count,failed_count,completed_at FROM resource_bulk_requests WHERE id=?").bind(result.bulkId).first<any>(); expect(changes?.count).toBe(1); expect(bulk).toMatchObject({operation_count:3,succeeded_count:1,failed_count:2}); expect(bulk.completed_at).toBeTruthy();
  });

  it("commits 20 valid creates in one explicit Bulk identity",async()=>{
    const {privateKey,publicKey}=await keys(); const userId=`usr_${crypto.randomUUID().replaceAll("-","")}`; const spaceId=`spc_${crypto.randomUUID().replaceAll("-","")}`; await seed(userId,spaceId); const bearer=await token(privateKey,userId);
    const response=await request(publicKey,bearer,`/api/v1/spaces/${spaceId}/models/bulk`,{operations:Array.from({length:20},(_,i)=>({operation:"create",modelKey:"task",data:{name:`Bulk ${i}`,assigneePersonIds:[]}}))}); expect(response.status).toBe(200); const result=(await json(response)).data; expect(result.items).toHaveLength(20); expect(result.items.every((x:any)=>x.status==="succeeded")).toBe(true); const db=(env as unknown as TestEnv).DB; const count=await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE bulk_id=?").bind(result.bulkId).first<{count:number}>(); expect(count?.count).toBe(20);
  });

  it("consumes a shared single-use Delegation for only one successful item",async()=>{
    const {privateKey,publicKey}=await keys(); const userId=`usr_${crypto.randomUUID().replaceAll("-","")}`; const agentId=`agt_${crypto.randomUUID().replaceAll("-","")}`; const spaceId=`spc_${crypto.randomUUID().replaceAll("-","")}`; await seed(userId,spaceId); const direct=await token(privateKey,userId); const represented=await token(privateKey,userId,agentId); const dlg=await delegation(publicKey,direct,spaceId,agentId);
    const response=await request(publicKey,represented,`/api/v1/spaces/${spaceId}/models/bulk`,{operations:[
      {operation:"create",modelKey:"task",delegationId:dlg,data:{name:"winner",assigneePersonIds:[]}},
      {operation:"create",modelKey:"task",delegationId:dlg,data:{name:"loser",assigneePersonIds:[]}},
    ]}); expect(response.status).toBe(200); const result=(await json(response)).data; expect(result.items.filter((x:any)=>x.status==="succeeded")).toHaveLength(1); expect(result.items.filter((x:any)=>x.status==="failed")).toHaveLength(1); const db=(env as unknown as TestEnv).DB; const changes=await db.prepare("SELECT COUNT(*) count FROM resource_changes WHERE bulk_id=?").bind(result.bulkId).first<{count:number}>(); expect(changes?.count).toBe(1);
  });
});
''')

# Migration safety and minimal contract assertions.
write('apps/core/scripts/schema50-non-atomic-bulk-migration-safety.test.mjs', r'''import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
const source = readFileSync(fileURLToPath(new URL("../migrations/0050_non_atomic_bulk.sql", import.meta.url)), "utf8");
test("schema 50 adds independent Bulk correlation without rewriting existing authority/history tables", () => {
  assert.match(source, /CREATE TABLE resource_bulk_requests/u);
  assert.match(source, /ADD COLUMN bulk_id/u);
  assert.match(source, /CHANGE_GROUPING_CONFLICT/u);
  assert.doesNotMatch(source, /DROP\s+TABLE\s+(resource_changes|resource_change_sets|domain_event_outbox|delegations)/iu);
  assert.match(source, /UPDATE\s+schema_metadata\s+SET\s+value='50'/iu);
});
''')

# Package/kernel version advances because Change History will expose bulkId in the
# follow-up Eventing/history slice; status must already track the schema-bearing release.
replace_once('apps/core/package.json', '"version": "0.45.0"', '"version": "0.46.0"')
replace_once('apps/core/src/kernel-contract.ts', 'export const CORE_KERNEL_CONTRACT_VERSION = "0.45.0";', 'export const CORE_KERNEL_CONTRACT_VERSION = "0.46.0";')
replace_once('apps/core/openapi.yaml', '"version": "0.45.0"', '"version": "0.46.0"')

# Runtime performance contract documents the common path and bounded contention fallback.
replace_once('docs/runtime-storage-performance.md',
'''| General Batch mutation, 1-20 operations | O(1) in item count | authority once; bounded grouped record/relation preparation; one atomic ChangeSet mutation batch |
| Single-use mutation | no extra standalone RTT | consume inside the same atomic mutation/Change batch |''',
'''| General Batch mutation, 1-20 operations | O(1) in item count | authority once; bounded grouped record/relation preparation; one atomic ChangeSet mutation batch |
| Non-atomic Bulk mutation, 1-20 operations | O(1) common path in item count | set-wise authority/target/relation preparation; one grouped mutation batch with independent guarded item outcomes |
| Bulk single-use contention slow path | O(N), bounded N<=20 | only after grouped commit is aborted by current single-use Delegation contention; replay survivors independently so unrelated items still commit |
| Single-use mutation | no extra standalone RTT | consume inside the same atomic mutation/Change batch |''')

replace_once('docs/runtime-storage-performance.md',
'''- one Change per committed resource mutation and one ChangeSet correlation for an explicit atomic Batch;
- atomic single-use Delegation consumption with the Change it authorizes;''',
'''- one Change per committed resource mutation and one ChangeSet correlation for an explicit atomic Batch;
- one `blk_*` correlation for an explicit non-atomic Bulk while every successful item remains its own committed Change and every failed item commits no Change;
- atomic single-use Delegation consumption with the Change it authorizes;''')

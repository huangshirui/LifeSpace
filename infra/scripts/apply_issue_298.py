from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, value: str) -> None:
    (ROOT / path).write_text(value, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# --- Core Delegation runtime -------------------------------------------------
path = "apps/core/src/delegation-routes.ts"
text = read(path)
text = replace_once(
    text,
    '''import {
  delegationChainStatement,
  delegationExpiryNarrows,
  delegationScopeContains,
  validateStructuralDelegationChain,
  type DelegationChainRow,
} from "./delegation-chain";''',
    '''import {
  delegationChainStatement,
  delegationExpiryNarrows,
  delegationScopeContains,
  groupDelegationChainRows,
  validateStructuralDelegationChain,
  type DelegationChainRow,
} from "./delegation-chain";''',
    "delegation-chain imports",
)
text = replace_once(
    text,
    'import { requireModelAccess } from "./model-authorization";',
    'import { requireModelAccessMany } from "./model-authorization";',
    "model authorization import",
)
text = replace_once(
    text,
    '''type CreateDelegationBody = {
  actor?: unknown;
  parentDelegationId?: unknown;
  scope?: unknown;
  constraints?: unknown;
};''',
    '''type CreateDelegationBody = {
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
type PreparedDelegationIssue = ParsedDelegationIssue & {
  delegationId: string;
  targetModelKey: string | null;
  parent: DelegationChainRow | null;
  createdAt: string;
  issuer: Actor;
};''',
    "delegation issue types",
)
text = replace_once(
    text,
    '''const MAX_REDELEGATION_DEPTH = 3;
const delegationAccess = new Set<DelegationAccess>(["free_busy", "read", "write", "manage"]);''',
    '''const MAX_REDELEGATION_DEPTH = 3;
const MAX_ATOMIC_DELEGATION_ISSUES = 20;
const delegationAccess = new Set<DelegationAccess>(["free_busy", "read", "write", "manage"]);
const delegationAccessRank: Record<DelegationAccess, number> = { free_busy: 1, read: 2, write: 3, manage: 4 };''',
    "delegation constants",
)

parse_helpers = r'''
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

'''
text = replace_once(text, "function effectiveStatus(\n", parse_helpers + "function effectiveStatus(\n", "parse issue helpers")

many_authority = r'''async function validateScopesAuthorityMany(
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
    for (const index of recordIndexes) {
      const recordId = scopes[index]!.target.id;
      const modelKey = byId.get(recordId);
      if (!modelKey) throw new ApiError("RESOURCE_NOT_FOUND", "Record Delegation target was not found", 404);
      targetModelKeys[index] = modelKey;
    }
  }

  const distinctModelKeys = [...new Set(targetModelKeys.filter((value): value is string => Boolean(value)))];
  const models = new Map<string, Awaited<ReturnType<typeof getRuntimeModel>>>();
  await Promise.all(distinctModelKeys.map(async (modelKey) => {
    const model = await getRuntimeModel(env, modelKey);
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

'''
pattern = re.compile(r"async function validateScopeAuthority\([\s\S]*?function childScopeShape\(")
match = pattern.search(text)
if not match:
    raise RuntimeError("authority helper block not found")
text = text[: match.start()] + many_authority + "function childScopeShape(" + text[match.end() :]

prepare_helpers = r'''
async function prepareDelegationIssues(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  values: readonly unknown[],
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
  const issuer = executionActor(principal);
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

async function commitDelegationIssues(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  issues: readonly PreparedDelegationIssue[],
): Promise<ReturnType<typeof dto>[]> {
  const statements = issues.flatMap((issue) => [
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

  // Cloudflare D1 batch is the atomic commit boundary: all Delegation/scopes are
  // persisted together, or the batch rolls back. Child issuance intentionally
  // does not consume any single-use ancestor.
  await env.DB.batch(statements);

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

async function issueDelegations(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  values: readonly unknown[],
): Promise<ReturnType<typeof dto>[]> {
  const prepared = await prepareDelegationIssues(env, principal, spaceId, values);
  return commitDelegationIssues(env, principal, spaceId, prepared);
}

'''
text = replace_once(text, "function selectRowsSql(): string {\n", prepare_helpers + "function selectRowsSql(): string {\n", "issuance prepare/commit helpers")

routes = r'''  app.post("/api/v1/spaces/:spaceId/delegations", async (context) => {
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

'''
route_pattern = re.compile(r'  app\.post\("/api/v1/spaces/:spaceId/delegations", async \(context\) => \{[\s\S]*?\n  app\.delete\("/api/v1/spaces/:spaceId/delegations/:delegationId"')
route_match = route_pattern.search(text)
if not route_match:
    raise RuntimeError("single Delegation POST route not found")
text = text[: route_match.start()] + routes + '  app.delete("/api/v1/spaces/:spaceId/delegations/:delegationId"' + text[route_match.end() :]
write(path, text)


# --- Kernel OpenAPI ----------------------------------------------------------
openapi_path = "apps/core/openapi.yaml"
doc = json.loads(read(openapi_path))
doc["info"]["version"] = "0.43.0"
if "atomic multi-Delegation issuance" not in doc["info"].get("description", ""):
    doc["info"]["description"] += " Kernel 0.43.0 adds bounded atomic multi-Delegation issuance while preserving one immutable scope per Delegation."

collection_path = "/api/v1/spaces/{spaceId}/delegations"
batch_path = "/api/v1/spaces/{spaceId}/delegations/batch"
collection = doc["paths"][collection_path]
single_post = collection["post"]
batch_post = copy.deepcopy(single_post)
batch_post["operationId"] = "issueDelegationsAtomically"
batch_post["description"] = (
    "Atomically issues 1..20 independent single-scope Delegations for one confirmed business intent. "
    "All items are validated against the Root Principal's current Authority before one D1 atomic commit; "
    "any failure commits none. Direct execution issues Root Delegations. Represented execution issues Child "
    "Delegations from explicit already-existing parents and preserves the Root Principal. Child issuance does "
    "not consume a single-use parent, and intra-request parent references are intentionally unsupported."
)
batch_post["requestBody"]["content"]["application/json"]["schema"] = {"$ref": "#/components/schemas/CreateDelegationBatchRequest"}
batch_post["responses"]["201"]["description"] = "Delegations atomically issued"
batch_post["responses"]["201"]["content"]["application/json"]["schema"] = {"$ref": "#/components/schemas/DelegationBatchResponse"}
doc["paths"][batch_path] = {
    "parameters": copy.deepcopy(collection.get("parameters", [])),
    "post": batch_post,
}

schemas = doc["components"]["schemas"]
schemas["CreateDelegationBatchRequest"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {"$ref": "#/components/schemas/CreateDelegationRequest"},
        }
    },
}
single_ref = single_post["responses"]["201"]["content"]["application/json"]["schema"]["$ref"]
single_name = single_ref.rsplit("/", 1)[-1]
batch_response = copy.deepcopy(schemas[single_name])
if "properties" not in batch_response or "data" not in batch_response["properties"]:
    raise RuntimeError("Delegation response wrapper does not expose data")
batch_response["properties"]["data"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {"$ref": "#/components/schemas/Delegation"},
        }
    },
}
schemas["DelegationBatchResponse"] = batch_response
write(openapi_path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")


# --- Contract sanity checks --------------------------------------------------
path = "apps/core/scripts/check-openapi.mjs"
text = read(path)
text = replace_once(text, 'document.info?.version !== "0.42.0"', 'document.info?.version !== "0.43.0"', "Kernel check version")
text = replace_once(
    text,
    '  "/api/v1/spaces/{spaceId}/delegations",\n  "/api/v1/spaces/{spaceId}/delegations/{delegationId}",',
    '  "/api/v1/spaces/{spaceId}/delegations",\n  "/api/v1/spaces/{spaceId}/delegations/batch",\n  "/api/v1/spaces/{spaceId}/delegations/{delegationId}",',
    "Kernel required batch path",
)
anchor = 'const schemas = document.components?.schemas ?? {};\n'
batch_check = r'''const atomicDelegations = document.paths?.["/api/v1/spaces/{spaceId}/delegations/batch"]?.post;
if (atomicDelegations?.operationId !== "issueDelegationsAtomically"
    || atomicDelegations?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/CreateDelegationBatchRequest"
    || atomicDelegations?.responses?.["201"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/DelegationBatchResponse") {
  throw new Error("Atomic multi-Delegation issuance contract is missing or malformed");
}
if (schemas.CreateDelegationBatchRequest?.properties?.items?.minItems !== 1
    || schemas.CreateDelegationBatchRequest?.properties?.items?.maxItems !== 20
    || schemas.DelegationBatchResponse?.properties?.data?.properties?.items?.maxItems !== 20) {
  throw new Error("Atomic multi-Delegation issuance must remain bounded to 1..20 items");
}

'''
text = replace_once(text, anchor, anchor + batch_check, "Kernel batch contract check")
write(path, text)

path = "apps/core/scripts/check-authority-contract.mjs"
text = read(path)
authority_batch_check = r'''
const batchPost = document.paths?.["/api/v1/spaces/{spaceId}/delegations/batch"]?.post;
const batchRequest = schemas.CreateDelegationBatchRequest;
if (!batchPost?.description?.includes("any failure commits none")
    || !batchPost.description.includes("Child issuance does not consume a single-use parent")
    || batchRequest?.properties?.items?.items?.$ref !== "#/components/schemas/CreateDelegationRequest"
    || batchRequest?.properties?.items?.minItems !== 1
    || batchRequest?.properties?.items?.maxItems !== 20) {
  throw new Error("Authority contract must expose bounded all-or-none multi-Delegation issuance over the same single-scope primitive");
}

'''
text = replace_once(text, 'console.log("Core Authority v3 contract sanity check passed");', authority_batch_check + 'console.log("Core Authority v3 contract sanity check passed");', "Authority batch contract check")
write(path, text)


# --- Package / source-of-truth version markers ------------------------------
path = "apps/core/package.json"
pkg = json.loads(read(path))
pkg["version"] = "0.43.0"
write(path, json.dumps(pkg, ensure_ascii=False, indent=2) + "\n")

path = "apps/core/AGENTS.md"
text = read(path)
text = replace_once(text, "current Kernel version: 0.42.0", "current Kernel version: 0.43.0", "Core AGENTS Kernel version")
write(path, text)


# --- Contract stability baseline --------------------------------------------
path = "docs/contract-stability-baseline.json"
baseline = json.loads(read(path))
core = next(item for item in baseline["contractSources"] if item["id"] == "core-kernel")
group = next(item for item in core["groups"] if item["id"] == "core-delegation")
group["operationPattern"] = r"^(GET|POST) /api/v1/spaces/\{spaceId\}/delegations$|^POST /api/v1/spaces/\{spaceId\}/delegations/batch$|^(GET|PATCH|DELETE) /api/v1/spaces/\{spaceId\}/delegations/\{delegationId\}$"
methods = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
operations = []
for route, item in doc.get("paths", {}).items():
    if not isinstance(item, dict):
        continue
    for method in item:
        if method.lower() in methods:
            operations.append(f"{method.upper()} {route}")
operations = sorted(set(operations))
core["operationSetSha256"] = "sha256:" + hashlib.sha256("\n".join(operations).encode()).hexdigest()
write(path, json.dumps(baseline, ensure_ascii=False, indent=2) + "\n")


# --- Architecture / consumer docs -------------------------------------------
path = "docs/authority-role-capability-redelegation.md"
text = read(path)
text = replace_once(
    text,
    "Status: **Accepted architecture; implementation pending in #302**",
    "Status: **Implemented architecture (#302 / PR #304); atomic multi-issuance completed by #298**",
    "Authority architecture status",
)
section19 = r'''## 19. Relationship to #298

#298 closes the remaining issuance consistency gap for one confirmed business intent that materializes as multiple independent Delegations.

Core exposes bounded atomic multi-issuance over the generalized Delegation primitive:

- request size is `1..20`;
- every item remains an independent immutable one-scope `dlg_*` object;
- a direct Principal may atomically issue multiple Root Delegations;
- a represented Actor may atomically issue multiple Child Delegations from explicit already-existing propagatable parents;
- all Root Principal Authority and parent-chain/narrowing checks complete before the write boundary;
- the D1 commit is all-or-none;
- Child issuance never consumes a single-use parent;
- v1 deliberately does not allow one item to reference a parent created by another item in the same request.

The multi-issue operation is an issuance atomicity primitive only. It does not create a Session Delegation, Approval Grant or multi-scope Delegation.

## 20. Implementation State

The repository implementation now includes:

- code-owned Entity Role Capability;
- Agent-as-Principal backed by explicit Data Grant Authority;
- bounded same-Application re-delegation with Root Principal preservation;
- set-wise chain resolution and chain-aware governed Change evidence;
- atomic single-use ancestor consumption on successful business exercise;
- bounded atomic multi-Delegation issuance for one confirmed business intent.

Production support remains a deployment fact and must be read from `docs/production/*`; repository/main/staging implementation alone must not be described as Production.
'''
section_pattern = re.compile(r"## 19\. Relationship to #298[\s\S]*?\Z")
if not section_pattern.search(text):
    raise RuntimeError("Authority #298 section not found")
text = section_pattern.sub(section19, text)
write(path, text)

path = "docs/agent-ready.md"
text = read(path)
text = replace_once(
    text,
    "10. Current released execution remains single-hop. Target architecture supports explicit bounded delegation chains: parent permission is required, the Root Principal is preserved, every child narrows scope/access/expiry/depth, and Core resolves the full chain from one leaf selector. See `docs/authority-role-capability-redelegation.md`.",
    "10. Current repository execution supports explicit bounded same-Application Delegation chains: parent permission is required, the Root Principal is preserved, every child narrows scope/access/expiry/depth, and Core resolves the full chain from one leaf selector. Production status remains separately tracked in `docs/production/*`. See `docs/authority-role-capability-redelegation.md`.",
    "Agent-ready chain status",
)
needle = "One user confirmation may authorize several independent Delegations.\n"
addition = '''One user confirmation may authorize several independent Delegations.\n\nFor that case Core exposes bounded atomic multi-issuance (`POST /api/v1/spaces/{spaceId}/delegations/batch`, 1..20 items). Every item is still one immutable single-scope Delegation. Validation of all Root Principal Authority and any existing parent chains completes before one all-or-none D1 commit. Direct execution issues Roots; represented execution issues Children from explicit existing parents. Child issuance does not consume single-use ancestors, and v1 does not allow intra-request parent references.\n'''
text = replace_once(text, needle, addition, "Agent-ready atomic issuance")
write(path, text)

path = "docs/contracts.md"
text = read(path)
heading = "# LifeSpace Contracts\n"
contracts_note = '''# LifeSpace Contracts\n\n## Kernel 0.43.0 — Atomic multi-Delegation issuance\n\nKernel 0.43.0 adds `POST /api/v1/spaces/{spaceId}/delegations/batch` for one confirmed business intent that must materialize 1..20 independent Delegations atomically. The operation reuses the generalized Root/Child Delegation primitive, validates all requested Authority/chain narrowing before one all-or-none commit, preserves one immutable scope per `dlg_*`, and never consumes a single-use parent merely by issuing a Child.\n\n'''
text = replace_once(text, heading, contracts_note, "Contracts 0.43 note")
write(path, text)

path = "README.md"
text = read(path)
paragraph_pattern = re.compile(r"The current repository Core Kernel contract is \*\*0\.41\.0\*\*\.[^\n]*\n")
replacement = (
    "The current repository Core Kernel contract is **0.43.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel 0.43.0 includes the generalized Authority v3 foundation plus bounded atomic 1..20 multi-Delegation issuance; every issued `dlg_*` remains an independent single-scope object. Production availability remains separately frozen under `docs/production/*`.\n"
)
text, count = paragraph_pattern.subn(replacement, text, count=1)
if count != 1:
    raise RuntimeError(f"README Kernel paragraph: expected one match, found {count}")
write(path, text)

print("Issue #298 source, contract, stability baseline and docs updated")

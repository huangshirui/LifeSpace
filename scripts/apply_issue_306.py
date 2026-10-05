from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)

# 1. Reuse #298's exact Delegation preparation/commit primitive from #306.
path = "apps/core/src/delegation-routes.ts"
text = read(path)
for old, new, label in [
    ("type ParsedDelegationIssue = {", "export type ParsedDelegationIssue = {", "ParsedDelegationIssue export"),
    ("type PreparedDelegationIssue = ParsedDelegationIssue & {", "export type PreparedDelegationIssue = ParsedDelegationIssue & {", "PreparedDelegationIssue export"),
    ("function parseCreateDelegationBody(value: unknown): ParsedDelegationIssue {", "export function parseCreateDelegationBody(value: unknown): ParsedDelegationIssue {", "parseCreateDelegationBody export"),
    ("async function prepareDelegationIssues(\n", "export async function prepareDelegationIssues(\n", "prepareDelegationIssues export"),
]:
    text = replace_once(text, old, new, label)

pattern = re.compile(r"async function commitDelegationIssues\(.*?\n\}\n\nasync function issueDelegations\(", re.S)
match = pattern.search(text)
if not match:
    raise SystemExit("commitDelegationIssues block not found")
replacement = '''export function delegationIssueStatements(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  issues: readonly PreparedDelegationIssue[],
) {
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

async function issueDelegations('''
text = text[:match.start()] + replacement + text[match.end():]
write(path, text)

# 2. Register routes and map DB transaction guards to stable API conflicts.
path = "apps/core/src/app.ts"
text = read(path)
text = replace_once(
    text,
    'import { registerDelegationRoutes } from "./delegation-routes";\n',
    'import { registerDelegationRoutes } from "./delegation-routes";\nimport { registerAuthorizationRequestRoutes } from "./authorization-request-routes";\n',
    "app import",
)
text = replace_once(
    text,
    '  if (message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE")) {\n',
    '''  if (message.includes("AUTH_REQUEST_NOT_PENDING") || message.includes("AUTH_REQUEST_APPROVAL_INCOMPLETE")) {
    return new ApiError(
      "AUTHORIZATION_REQUEST_NOT_PENDING",
      "Authorization Request is no longer eligible for approval",
      409,
    );
  }
  if (message.includes("DELEGATION_SINGLE_USE_UNAVAILABLE")) {
''',
    "database error mapping",
)
text = replace_once(
    text,
    '  registerDelegationRoutes(app);\n',
    '  registerDelegationRoutes(app);\n  registerAuthorizationRequestRoutes(app);\n',
    "route registration",
)
write(path, text)

# 3. Transitional verified direct Agent JWT + canonical lsp_agt_* both use the same protocol.
path = "apps/core/src/authorization-request-routes.ts"
text = read(path)
text = replace_once(
    text,
    '  if (principal.type !== "agent" || principal.actor || principal.purpose !== "agent_api") {',
    '  if (principal.type !== "agent" || principal.actor\n      || (principal.purpose !== "agent_api" && principal.purpose !== "agent_execution")) {',
    "requesting agent profile",
)
text = text.replace(
    '"Authorization Request operations require a direct Agent API credential"',
    '"Authorization Request operations require a verified direct Agent execution context"',
)
write(path, text)

# 4. Kernel contract version moves to 0.45.0.
for path in ["apps/core/src/kernel-contract.ts", "apps/core/package.json", "apps/core/scripts/check-openapi.mjs"]:
    text = read(path)
    if "0.44.0" not in text:
        raise SystemExit(f"{path}: expected 0.44.0")
    text = text.replace("0.44.0", "0.45.0")
    write(path, text)

path = "apps/core/AGENTS.md"
text = read(path)
text = replace_once(text, "current Kernel version: 0.44.0", "current Kernel version: 0.45.0", "core AGENTS version")
write(path, text)

# 5. Add the public contract and schemas. The file is intentionally compact JSON.
path = "apps/core/openapi.yaml"
doc = json.loads(read(path))
doc["info"]["version"] = "0.45.0"
doc["info"]["description"] += " Kernel 0.45.0 adds durable transport-independent Authorization Requests (arq_*) with opaque review tokens and atomic Delegation materialization on confirmation."
if not any(tag.get("name") == "Authorization Requests" for tag in doc.get("tags", [])):
    tags = doc.setdefault("tags", [])
    delegation_index = next((i for i, tag in enumerate(tags) if tag.get("name") == "Delegations"), len(tags))
    tags.insert(delegation_index, {"name": "Authorization Requests"})

schemas = doc.setdefault("components", {}).setdefault("schemas", {})
status_contract = schemas.get("StatusResponse", {}).get("properties", {}).get("data", {}).get("properties", {}).get("contractVersion")
if not isinstance(status_contract, dict):
    raise SystemExit("StatusResponse.contractVersion schema missing")
status_contract["const"] = "0.45.0"

schemas["AuthorizationRequestCorrelation"] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "sessionId": {"type": "string", "minLength": 1, "maxLength": 256},
        "conversationId": {"type": "string", "minLength": 1, "maxLength": 256},
    },
}
schemas["AuthorizationRequestItem"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["scope", "constraints"],
    "properties": {
        "scope": {"$ref": "#/components/schemas/DelegationScope"},
        "constraints": {"$ref": "#/components/schemas/DelegationConstraints"},
    },
}
schemas["CreateAuthorizationRequestItem"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["scope"],
    "properties": {
        "scope": {"$ref": "#/components/schemas/DelegationScope"},
        "constraints": {"$ref": "#/components/schemas/DelegationConstraints"},
    },
}
schemas["AuthorizationRequestConfirmation"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["requestId", "principal", "actor", "applicationId", "spaceId", "items", "requestExpiresAt"],
    "properties": {
        "requestId": {"type": "string", "pattern": "^arq_[A-Za-z0-9_-]+$"},
        "principal": {
            "type": "object", "additionalProperties": False, "required": ["type", "id"],
            "properties": {"type": {"const": "user"}, "id": {"type": "string", "pattern": "^usr_[A-Za-z0-9_-]+$"}},
        },
        "actor": {
            "type": "object", "additionalProperties": False, "required": ["type", "id"],
            "properties": {"type": {"const": "agent"}, "id": {"type": "string", "pattern": "^agt_[A-Za-z0-9_-]+$"}},
        },
        "applicationId": {"type": "string", "minLength": 1},
        "spaceId": {"type": "string", "pattern": "^spc_[A-Za-z0-9_-]+$"},
        "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/AuthorizationRequestItem"}},
        "requestExpiresAt": {"type": "string", "format": "date-time"},
    },
}
schemas["AuthorizationRequest"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["id", "status", "principal", "actor", "applicationId", "spaceId", "items", "requestExpiresAt", "createdAt", "decidedAt", "correlation", "confirmation"],
    "properties": {
        "id": {"type": "string", "pattern": "^arq_[A-Za-z0-9_-]+$"},
        "status": {"type": "string", "enum": ["pending", "approved", "denied", "cancelled", "expired"]},
        "principal": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation/properties/principal"},
        "actor": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation/properties/actor"},
        "applicationId": {"type": "string", "minLength": 1},
        "spaceId": {"type": "string", "pattern": "^spc_[A-Za-z0-9_-]+$"},
        "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/AuthorizationRequestItem"}},
        "requestExpiresAt": {"type": "string", "format": "date-time"},
        "createdAt": {"type": "string", "format": "date-time"},
        "decidedAt": {"type": ["string", "null"], "format": "date-time"},
        "correlation": {"anyOf": [{"$ref": "#/components/schemas/AuthorizationRequestCorrelation"}, {"type": "null"}]},
        "confirmation": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation"},
    },
}
schemas["CreateAuthorizationRequestRequest"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["principalUserId", "items"],
    "properties": {
        "principalUserId": {"type": "string", "pattern": "^usr_[A-Za-z0-9_-]+$", "description": "Target User Principal for the requested authorization. This field is request subject data, not authenticated caller identity."},
        "items": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/CreateAuthorizationRequestItem"}},
        "requestTtlMinutes": {"type": "integer", "minimum": 1, "maximum": 1440, "default": 60},
        "correlation": {"$ref": "#/components/schemas/AuthorizationRequestCorrelation"},
    },
}
schemas["CreateAuthorizationRequestResult"] = {
    "allOf": [
        {"$ref": "#/components/schemas/AuthorizationRequest"},
        {"type": "object", "required": ["reviewToken", "reused"], "properties": {
            "reviewToken": {"type": "string", "pattern": "^arv_[A-Za-z0-9_-]+$", "description": "Opaque continuation secret returned only to the trusted request flow; plaintext is never stored."},
            "reused": {"type": "boolean"},
        }},
    ]
}
schemas["ReviewAuthorizationRequestRequest"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["reviewToken"],
    "properties": {
        "reviewToken": {"type": "string", "pattern": "^arv_[A-Za-z0-9_-]+$"},
        "confirmation": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation"},
    },
}
schemas["AuthorizationRequestResponse"] = {
    "type": "object", "required": ["data"], "properties": {"data": {"$ref": "#/components/schemas/AuthorizationRequest"}}
}
schemas["CreateAuthorizationRequestResponse"] = {
    "type": "object", "required": ["data"], "properties": {"data": {"$ref": "#/components/schemas/CreateAuthorizationRequestResult"}}
}
schemas["ConfirmAuthorizationRequestResult"] = {
    "type": "object", "additionalProperties": False, "required": ["request", "delegations"],
    "properties": {
        "request": {"$ref": "#/components/schemas/AuthorizationRequest"},
        "delegations": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"$ref": "#/components/schemas/Delegation"}},
    },
}
schemas["ConfirmAuthorizationRequestResponse"] = {
    "type": "object", "required": ["data"], "properties": {"data": {"$ref": "#/components/schemas/ConfirmAuthorizationRequestResult"}}
}

common_responses = {
    "400": {"$ref": "#/components/responses/InvalidRequest"},
    "401": {"$ref": "#/components/responses/Unauthorized"},
    "403": {"$ref": "#/components/responses/Forbidden"},
    "404": {"$ref": "#/components/responses/NotFound"},
    "409": {"$ref": "#/components/responses/Conflict"},
}
space_param = {"$ref": "#/components/parameters/SpaceId"}
request_param = {"name": "requestId", "in": "path", "required": True, "schema": {"type": "string", "pattern": "^arq_[A-Za-z0-9_-]+$"}}
paths = doc.setdefault("paths", {})
paths["/api/v1/spaces/{spaceId}/authorization-requests"] = {
    "parameters": [space_param],
    "post": {
        "tags": ["Authorization Requests"],
        "operationId": "createAuthorizationRequest",
        "description": "Creates or reuses an identical still-valid pending arq_* for a verified direct Agent. Creation grants no Authority. principalUserId is the requested User subject, not caller authentication. Each create/reuse returns a fresh opaque reviewToken while Core stores only its hash.",
        "requestBody": {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/CreateAuthorizationRequestRequest"}}}},
        "responses": {"201": {"description": "Pending Authorization Request created or reused", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/CreateAuthorizationRequestResponse"}}}}, **common_responses},
    },
}
base = "/api/v1/spaces/{spaceId}/authorization-requests/{requestId}"
paths[base] = {
    "parameters": [space_param, request_param],
    "get": {
        "tags": ["Authorization Requests"], "operationId": "getAuthorizationRequest",
        "description": "Returns the requesting Agent/Application's durable Authorization Request state. Expired pending requests are materialized as expired.",
        "responses": {"200": {"description": "Authorization Request", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}}, **common_responses},
    },
}
paths[base + "/confirm"] = {
    "parameters": [space_param, request_param],
    "post": {
        "tags": ["Authorization Requests"], "operationId": "confirmAuthorizationRequest",
        "description": "Confirms one pending request using its opaque reviewToken. When confirmation is supplied it must be structurally equal to Core's canonical projection. Core rechecks the target User Principal's current Authority and atomically issues 1..20 independent single-scope Delegations plus the approved state; any failure commits none.",
        "requestBody": {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ReviewAuthorizationRequestRequest"}}}},
        "responses": {"200": {"description": "Request approved and Delegations atomically materialized", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ConfirmAuthorizationRequestResponse"}}}}, **common_responses},
    },
}
paths[base + "/deny"] = {
    "parameters": [space_param, request_param],
    "post": {
        "tags": ["Authorization Requests"], "operationId": "denyAuthorizationRequest",
        "description": "Records explicit rejection from the trusted review flow. Denial requires the request-bound reviewToken and never creates Authority.",
        "requestBody": {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ReviewAuthorizationRequestRequest"}}}},
        "responses": {"200": {"description": "Request denied", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}}, **common_responses},
    },
}
paths[base + "/cancel"] = {
    "parameters": [space_param, request_param],
    "post": {
        "tags": ["Authorization Requests"], "operationId": "cancelAuthorizationRequest",
        "description": "Lets the same verified requesting Agent/Application cancel a pending request it no longer needs. Cancellation is distinct from User denial and creates no Authority.",
        "responses": {"200": {"description": "Request cancelled", "content": {"application/json": {"schema": {"$ref": "#/components/schemas/AuthorizationRequestResponse"}}}}, **common_responses},
    },
}
write(path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")

# 6. Contract sanity gate owns the new Authority protocol.
path = "apps/core/scripts/check-authority-contract.mjs"
text = read(path)
anchor = 'console.log("Core Authority v3 contract sanity check passed");'
insert = '''const authorizationCreate = document.paths?.["/api/v1/spaces/{spaceId}/authorization-requests"]?.post;
const authorizationConfirm = document.paths?.["/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/confirm"]?.post;
const authorizationRequest = schemas.CreateAuthorizationRequestRequest;
const reviewRequest = schemas.ReviewAuthorizationRequestRequest;
if (!authorizationCreate?.description?.includes("grants no Authority")
    || authorizationRequest?.properties?.requestTtlMinutes?.default !== 60
    || authorizationRequest?.properties?.requestTtlMinutes?.minimum !== 1
    || authorizationRequest?.properties?.requestTtlMinutes?.maximum !== 1440
    || authorizationRequest?.properties?.items?.minItems !== 1
    || authorizationRequest?.properties?.items?.maxItems !== 20
    || !authorizationConfirm?.description?.includes("any failure commits none")
    || !reviewRequest?.required?.includes("reviewToken")
    || !reviewRequest?.properties?.confirmation) {
  throw new Error("Authority contract must expose durable bounded Authorization Request confirmation semantics");
}

console.log("Core Authority v4 contract sanity check passed");'''
text = replace_once(text, anchor, insert, "authority contract gate")
write(path, text)

# 7. Stability classification: new routes are Candidate Public, stable groups stay untouched.
path = "docs/contract-stability-baseline.json"
baseline = json.loads(read(path))
core = next(source for source in baseline["contractSources"] if source["id"] == "core-kernel")
if not any(group["id"] == "core-authorization-requests" for group in core["groups"]):
    delegation_index = next(i for i, group in enumerate(core["groups"]) if group["id"] == "core-delegation")
    core["groups"].insert(delegation_index + 1, {
        "id": "core-authorization-requests",
        "maturity": "candidate",
        "visibility": "public",
        "operationPattern": r"^(GET|POST) /api/v1/spaces/\{spaceId\}/authorization-requests(?:/\{requestId\}(?:/(?:confirm|deny|cancel))?)?$",
    })
operations = []
for route, item in doc.get("paths", {}).items():
    if not isinstance(item, dict):
        continue
    for method in item:
        if method.lower() in {"get", "post", "put", "patch", "delete", "options", "head", "trace"}:
            operations.append(f"{method.upper()} {route}")
core["operationSetSha256"] = "sha256:" + hashlib.sha256("\n".join(sorted(set(operations))).encode()).hexdigest()
write(path, json.dumps(baseline, ensure_ascii=False, indent=2) + "\n")

# 8. Human-readable current repository docs (not production docs).
path = "docs/agent-ready.md"
text = read(path)
text = text.replace(
    "Core returns allow/deny. It does not orchestrate authorization UX, find a grantor, create approval requests, or decide whether the caller should prompt the user.",
    "Core returns allow/deny and owns durable Authorization Request state when an Agent explicitly asks a User Principal for new Delegation. Core still does not decide when to prompt, how a Chat/WeCom/n8n surface presents the request, or how the application routes the human response.",
)
start = text.index("## 5. Authorization protocol boundary")
end = text.index("## 6. First-class Batch Change")
section = '''## 5. Authorization Request protocol boundary

LifeSpace owns the durable Authority truth for an explicit Agent -> User authorization request while applications/adapters own presentation and transport orchestration.

Canonical flow:

```text
verified direct Agent context
  -> POST .../authorization-requests
  -> durable arq_* (pending; grants no Authority)
  -> trusted human-review transport
  -> confirm | deny | cancel
  -> confirm rechecks current User Authority
  -> one atomic commit: approved + 1..20 independent dlg_*
```

Rules:

1. `arq_*` is the request identity. `sessionId` / `conversationId` are correlation metadata only.
2. Request creation may identify a target `usr_*`, but that field is request-subject data, not authenticated caller identity and grants no Authority.
3. One request contains 1..20 requested single-scope Delegation items. The canonical Delegation Scope/constraints vocabulary is reused; there is no n8n-specific Authority model.
4. Request TTL defaults to 60 minutes and is bounded to 1..1440 minutes. Request expiry is independent from each eventual Delegation expiry.
5. Identical still-valid pending requests are reused. Every creation/reuse returns a fresh opaque `reviewToken`; Core stores only its hash.
6. `confirmation` is a structured projection generated from canonical request state. AI-mediated adapters may submit the copied projection at Confirm; if supplied, Core requires structured equality. Deterministic trusted workflows may omit it.
7. Confirm requires the request-bound `reviewToken`, rechecks the User Principal's current Authority, and reuses the same #298 atomic multi-Delegation primitive. No partial approved state is allowed.
8. `denied` means the trusted review path recorded explicit User rejection. `cancelled` means the requesting Agent/Application no longer needs the request. They are distinct terminal states.
9. Only the same verified requesting Agent/Application may read/cancel/review its request. Authorization Request persistence is transport independent and contains no n8n/Chat/WeCom orchestration state.
10. `reviewToken` is continuation/review evidence bound to one request; it is not a reusable User credential, not a Delegation and not business Authority.

The Application/Agent still decides when authorization is needed, how to explain scopes, and how to route a human response. LifeSpace owns the immutable requested Authority, lifecycle, current-state recheck and final Delegation materialization.

'''
text = text[:start] + section + text[end:]
write(path, text)

path = "docs/permissions.md"
text = read(path)
text = text.replace(
    "A future implementation of richer Agent identity, delegation, consent or approval must extend these foundations deliberately and update contracts/tests before being described as supported behavior.",
    "Agent identity, Delegation and first-class Authorization Request consent extend these foundations without treating request `userId` as authenticated identity; new approval forms must continue to update contracts/tests deliberately before being described as supported behavior.",
)
write(path, text)

path = "docs/contracts.md"
text = read(path)
text = text.replace("Kernel `0.44.0` adds first-class opaque Agent API credential", "Kernel `0.45.0` adds first-class durable `arq_*` Authorization Requests and atomic confirmation on top of Kernel `0.44.0` first-class opaque Agent API credential", 1)
text += "\n### Kernel 0.45.0 — Authorization Request\n\nKernel 0.45.0 adds transport-independent `arq_*` pending authorization state, 60-minute default / 1..1440-minute request TTL, request-bound opaque review tokens stored only as hashes, optional canonical confirmation equality, explicit approve/deny/cancel/expired lifecycle, idempotent reuse of identical pending requests, current User Authority recheck at confirmation, and all-or-none materialization of 1..20 independent single-scope `dlg_*` through the existing atomic Delegation primitive. Request creation itself grants no Authority.\n"
write(path, text)

path = "README.md"
text = read(path)
text = replace_once(text, "The current repository Core Kernel contract is **0.44.0**.", "The current repository Core Kernel contract is **0.45.0**.", "README kernel version")
text = text.replace("Kernel 0.44.0 accepts first-class opaque", "Kernel 0.45.0 adds durable `arq_*` Authorization Requests with request-bound review tokens and atomic Delegation materialization; Kernel 0.44.0 accepts first-class opaque", 1)
write(path, text)

print("Applied #306 Authorization Request implementation wiring and contract updates")

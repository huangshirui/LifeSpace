from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


# #306 trust boundary:
# - lsp_agt_* authenticates the requesting Agent/Application.
# - principalUserId is trusted adapter/workflow identity context only; it grants no Authority.
# - Confirm/Deny must bind the current trusted workflow user to the immutable arq_* principal.
# - principalUserId must never be exposed as an LLM/Agent Tool argument.
route = ROOT / "apps/core/src/authorization-request-routes.ts"
text = route.read_text()
text = replace_once(
    text,
    'type ConfirmBody = { confirmation?: unknown };',
    'type ConfirmBody = { principalUserId?: unknown; confirmation?: unknown };\ntype DenyBody = { principalUserId?: unknown };',
    "authorization request decision body types",
)

helper_anchor = '''function requestTtl(value: unknown): number {\n'''
helper = '''function assertIntendedUser(row: RequestRow, value: unknown): string {\n  const currentUserId = principalUserId(value);\n  if (currentUserId !== row.intended_user_id) {\n    throw new ApiError(\n      "AUTHORIZATION_REQUEST_PRINCIPAL_MISMATCH",\n      "Trusted workflow User does not match the Authorization Request Principal",\n      403,\n    );\n  }\n  return currentUserId;\n}\n\n'''
text = replace_once(text, helper_anchor, helper + helper_anchor, "intended user helper")

old_terminal_signature = '''  requestId: string,\n  target: "denied" | "cancelled",\n) {\n  const loaded = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));\n'''
new_terminal_signature = '''  requestId: string,\n  target: "denied" | "cancelled",\n  currentUserId?: string,\n) {\n  const loaded = assertOwned(principal, actor, await loadRequest(env, spaceId, requestId));\n  if (target === "denied") {\n    assertIntendedUser(loaded.row, currentUserId);\n  }\n'''
text = replace_once(text, old_terminal_signature, new_terminal_signature, "terminal transition user binding")

old_confirm_body = '''    const body = await context.req.json<ConfirmBody>().catch(() => ({}));\n    if (!body || typeof body !== "object" || Array.isArray(body)\n        || Object.keys(body).some((key) => key !== "confirmation")) {\n      throw new ApiError("INVALID_REQUEST", "Confirm body accepts only optional confirmation", 400);\n    }\n\n    const loaded = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));\n'''
new_confirm_body = '''    const rawBody = await context.req.json<unknown>().catch(() => null);\n    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)\n        || Object.keys(rawBody).some((key) => !["principalUserId", "confirmation"].includes(key))) {\n      throw new ApiError(\n        "INVALID_REQUEST",\n        "Confirm body requires trusted principalUserId and accepts optional confirmation",\n        400,\n      );\n    }\n    const body = rawBody as ConfirmBody;\n\n    const loaded = assertOwned(principal, actor, await loadRequest(context.env, spaceId, requestId));\n    assertIntendedUser(loaded.row, body.principalUserId);\n'''
text = replace_once(text, old_confirm_body, new_confirm_body, "confirm trusted user body")

old_deny = '''  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/deny", async (context) => {\n    const principal = context.get("principal");\n    const actor = requestingAgent(principal);\n    const loaded = await terminalTransition(\n      context.env,\n      principal,\n      actor,\n      context.req.param("spaceId"),\n      context.req.param("requestId"),\n      "denied",\n    );\n    return context.json(success(requestDto(loaded.row, loaded.items)));\n  });\n'''
new_deny = '''  app.post("/api/v1/spaces/:spaceId/authorization-requests/:requestId/deny", async (context) => {\n    const principal = context.get("principal");\n    const actor = requestingAgent(principal);\n    const rawBody = await context.req.json<unknown>().catch(() => null);\n    if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)\n        || Object.keys(rawBody).some((key) => key !== "principalUserId")) {\n      throw new ApiError("INVALID_REQUEST", "Deny body requires only trusted principalUserId", 400);\n    }\n    const body = rawBody as DenyBody;\n    const currentUserId = principalUserId(body.principalUserId);\n    const loaded = await terminalTransition(\n      context.env,\n      principal,\n      actor,\n      context.req.param("spaceId"),\n      context.req.param("requestId"),\n      "denied",\n      currentUserId,\n    );\n    return context.json(success(requestDto(loaded.row, loaded.items)));\n  });\n'''
text = replace_once(text, old_deny, new_deny, "deny trusted user body")
route.write_text(text)

# Public contract: user identity context is supplied by the trusted adapter/workflow,
# never by the LLM, and is checked again at the User decision boundary.
openapi = ROOT / "apps/core/openapi.yaml"
doc = json.loads(openapi.read_text())
schemas = doc["components"]["schemas"]
trusted_user = {
    "type": "string",
    "pattern": "^usr_[A-Za-z0-9_-]+$",
    "description": "Trusted server-side current User context supplied by the adapter/workflow. It is identity context only, grants no Authority, and must never be exposed as an LLM/Agent Tool argument.",
}
schemas["ConfirmAuthorizationRequest"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["principalUserId"],
    "properties": {
        "principalUserId": trusted_user,
        "confirmation": {"$ref": "#/components/schemas/AuthorizationRequestConfirmation"},
    },
}
schemas["DenyAuthorizationRequest"] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["principalUserId"],
    "properties": {"principalUserId": trusted_user},
}
confirm_op = doc["paths"]["/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/confirm"]["post"]
confirm_op["description"] = (
    "Confirms one pending request through the same authenticated Agent/Application and the trusted server-side current User context. "
    "principalUserId must match the immutable request Principal and must never be an LLM argument. Optional confirmation must be structurally equal to the canonical projection. "
    "Core rechecks the intended User's current Authority and atomically records approval plus 1..20 independent Delegations using the same issuance primitive as /delegations/batch. Repeated approved confirmation is idempotent."
)
confirm_op["requestBody"] = {
    "required": True,
    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ConfirmAuthorizationRequest"}}},
}
deny_op = doc["paths"]["/api/v1/spaces/{spaceId}/authorization-requests/{requestId}/deny"]["post"]
deny_op["description"] = (
    "Records explicit User rejection through the trusted presentation workflow. The supplied trusted principalUserId must match the immutable request Principal; "
    "Agent/Application ownership is also rechecked and no Delegation is issued."
)
deny_op["requestBody"] = {
    "required": True,
    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/DenyAuthorizationRequest"}}},
}
# Tighten the creation description without changing the chosen trust model.
schemas["CreateAuthorizationRequest"]["properties"]["principalUserId"]["description"] = (
    "Trusted server-side intended User context supplied by the adapter/workflow. It is identity context only, grants no Authority, and must never be exposed as an LLM/Agent Tool argument."
)
openapi.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")

# Contract gate must freeze the trusted-user decision requirement as part of Kernel 0.45.
check = ROOT / "apps/core/scripts/check-openapi.mjs"
check_text = check.read_text()
old_assertion = '''    || schemas.CreateAuthorizationRequest?.properties?.requestTtlMinutes?.default !== 60\n    || schemas.CreateAuthorizationRequest?.properties?.requestTtlMinutes?.maximum !== 1440\n    || JSON.stringify(schemas.AuthorizationRequest?.properties?.status?.enum) !== JSON.stringify(["pending", "approved", "denied", "cancelled", "expired"])) {\n'''
new_assertion = '''    || schemas.CreateAuthorizationRequest?.properties?.requestTtlMinutes?.default !== 60\n    || schemas.CreateAuthorizationRequest?.properties?.requestTtlMinutes?.maximum !== 1440\n    || !schemas.ConfirmAuthorizationRequest?.required?.includes("principalUserId")\n    || !schemas.DenyAuthorizationRequest?.required?.includes("principalUserId")\n    || JSON.stringify(schemas.AuthorizationRequest?.properties?.status?.enum) !== JSON.stringify(["pending", "approved", "denied", "cancelled", "expired"])) {\n'''
check_text = replace_once(check_text, old_assertion, new_assertion, "OpenAPI decision binding gate")
check.write_text(check_text)

# Human-readable boundary: no User Proof/token exchange. The trusted backend may assert
# who the current user is, but only Core's current Authority evaluation decides what that user may delegate.
agent_ready = ROOT / "docs/agent-ready.md"
a = agent_ready.read_text()
old_paragraph = '''`arq_*` is the durable transport-independent pending user-confirmation state for Agent integrations. Request creation grants no Authority. The authenticated Agent/Application may carry an already-resolved trusted workflow `usr_*` as the intended user context, but that value is not authentication and must never become an AI argument. Core owns immutable requested scopes, request TTL (default 60 minutes, bounded 1..1440), pending reuse, terminal state, and canonical confirmation projection.\n'''
new_paragraph = '''`arq_*` is the durable transport-independent pending user-confirmation state for Agent integrations. Request creation grants no Authority. The authenticated Agent/Application may carry an already-resolved trusted workflow `usr_*` as identity context; no extra User Proof/token exchange is required. This value is not Authority, must never become an AI/LLM argument, and Confirm/Deny must present the current trusted workflow `usr_*` again so Core can require an exact match with the immutable request Principal. Core owns immutable requested scopes, request TTL (default 60 minutes, bounded 1..1440), pending reuse, terminal state, and canonical confirmation projection.\n'''
a = replace_once(a, old_paragraph, new_paragraph, "agent-ready trusted identity boundary")
agent_ready.write_text(a)

contracts = ROOT / "docs/contracts.md"
c = contracts.read_text()
marker = "- Kernel 0.45.0 adds transport-independent `arq_*` Authorization Request lifecycle endpoints. Request creation is non-authorizing; Confirm reuses atomic Delegation issuance and current Authority checks.\n"
replacement = "- Kernel 0.45.0 adds transport-independent `arq_*` Authorization Request lifecycle endpoints. Request creation is non-authorizing; the trusted adapter/workflow supplies `principalUserId` as identity context (never as Authority or an LLM argument), Confirm/Deny bind the decision to that same User, and Confirm reuses atomic Delegation issuance with current Authority checks. No separate User Proof/token exchange is introduced.\n"
if marker in c:
    c = c.replace(marker, replacement, 1)
elif replacement not in c:
    raise SystemExit("contracts #306 marker missing")
contracts.write_text(c)

# Integration coverage for the new decision boundary plus existing correctness cases.
test = ROOT / "apps/core/test/authorization-request.integration.test.ts"
t = test.read_text()
# Existing confirmation equality paths.
t = t.replace('JSON.stringify({ confirmation: mutated })', 'JSON.stringify({ principalUserId: userId, confirmation: mutated })')
t = t.replace('JSON.stringify({ confirmation: created.confirmation })', 'JSON.stringify({ principalUserId: userId, confirmation: created.confirmation })')
t = t.replace('method: "POST", body: JSON.stringify({}),', 'method: "POST", body: JSON.stringify({ principalUserId: userId }),', 1)
# Terminal and failure paths.
t = t.replace(
    'const denied = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, { method: "POST" });',
    'const denied = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });',
    1,
)
t = t.replace(
    'const afterDeny = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/confirm`, bearer, { method: "POST" });',
    'const afterDeny = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });',
    1,
)
t = t.replace(
    'const response = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST" });',
    'const response = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });',
    1,
)
t = t.replace(
    'const confirm = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST" });',
    'const confirm = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });',
    1,
)
t = t.replace(
    'request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST" }),\n      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/deny`, bearer, { method: "POST" }),',
    'request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) }),\n      request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/deny`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) }),',
    1,
)

# Explicitly prove that an Agent cannot apply A's decision while the trusted workflow says B.
insert_anchor = '''    const mutated = structuredClone(created.confirmation);\n'''
principal_mismatch_test = '''    const wrongUserConfirm = await request(\n      publicKey,\n      `/api/v1/spaces/${spaceId}/authorization-requests/${created.id}/confirm`,\n      bearer,\n      { method: "POST", body: JSON.stringify({ principalUserId: `usr_wrong_${suffix}` }) },\n    );\n    expect(wrongUserConfirm.status).toBe(403);\n    expect((await json(wrongUserConfirm)).error.code).toBe("AUTHORIZATION_REQUEST_PRINCIPAL_MISMATCH");\n    expect(await count(db, "delegations")).toBe(0);\n\n'''
t = replace_once(t, insert_anchor, principal_mismatch_test + insert_anchor, "confirm principal mismatch test")

deny_anchor = '''    const denied = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, { method: "POST", body: JSON.stringify({ principalUserId: userId }) });\n'''
wrong_deny = '''    const wrongUserDeny = await request(publicKey, `/api/v1/spaces/${spaceId}/authorization-requests/${deniedRequest.id}/deny`, bearer, {\n      method: "POST", body: JSON.stringify({ principalUserId: `usr_wrong_${suffix}` }),\n    });\n    expect(wrongUserDeny.status).toBe(403);\n    expect((await json(wrongUserDeny)).error.code).toBe("AUTHORIZATION_REQUEST_PRINCIPAL_MISMATCH");\n\n'''
t = replace_once(t, deny_anchor, wrong_deny + deny_anchor, "deny principal mismatch test")

# Fail fast if any user-decision test accidentally still posts without a body.
for line in t.splitlines():
    if "/confirm`" in line or "/deny`" in line:
        # Multi-line calls are checked by the TypeScript/runtime tests; this guard only catches old one-line POSTs.
        if '{ method: "POST" });' in line:
            raise SystemExit(f"unbound user decision call remains: {line.strip()}")
test.write_text(t)

print("Applied #306 trusted workflow User binding and TypeScript fixes")

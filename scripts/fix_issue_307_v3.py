from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    text = read(path)
    if addition.strip() in text:
        return
    if marker not in text:
        raise SystemExit(f"{path}: marker not found: {marker[:120]!r}")
    write(path, text.replace(marker, addition + marker, 1))


# ---------------------------------------------------------------------------
# Core: opaque Agent credential represented mode is User/Agent only.
# ---------------------------------------------------------------------------
replace_once(
    "apps/core/src/delegation-chain.ts",
    '''    || leaf.application_id !== authenticatedAgent.clientId\n    || leaf.source_space_id !== spaceId\n    || (leaf.principal_type === "agent" && leaf.principal_id === authenticatedAgent.id)) {\n    throw new ApiError("DELEGATION_INVALID", "Delegation does not represent this authenticated Agent credential", 403);\n''',
    '''    || leaf.application_id !== authenticatedAgent.clientId\n    || leaf.source_space_id !== spaceId\n    || leaf.principal_type !== "user") {\n    throw new ApiError("DELEGATION_INVALID", "Agent API credential Delegation must represent User authority for this authenticated Agent", 403);\n''',
)

write(
    "apps/core/test/agent-api-credential-boundary.test.ts",
    '''import { describe, expect, it } from "vitest";\nimport { resolveAgentApiDelegatedPrincipal, type DelegationChainRow } from "../src/delegation-chain";\nimport type { Principal } from "../src/env";\n\nfunction row(principalType: "user" | "agent" | "service" | "device", principalId: string): DelegationChainRow {\n  return {\n    delegation_id: "dlg_boundary",\n    parent_delegation_id: null,\n    remaining_redelegation_depth: 0,\n    principal_type: principalType,\n    principal_id: principalId,\n    actor_type: "agent",\n    actor_id: "agt_boundary",\n    application_id: "app_boundary",\n    source_space_id: "spc_boundary",\n    created_by_type: "user",\n    created_by_id: "usr_owner",\n    delegation_revoked_at: null,\n    delegation_expires_at: null,\n    delegation_max_uses: null,\n    delegation_consumed_at: null,\n    delegation_target_type: "model",\n    delegation_target_id: "task",\n    delegation_target_model_key: "task",\n    delegation_max_access: "write",\n    selected_leaf: 1,\n  };\n}\n\ndescribe("Agent API credential represented-principal boundary", () => {\n  const credential: Principal = {\n    type: "agent",\n    id: "agt_boundary",\n    clientId: "app_boundary",\n    scopes: ["resources:read", "resources:write"],\n    tokenId: "agc_boundary",\n    purpose: "agent_api",\n  };\n\n  it("accepts User/Agent representation and rejects Service/Agent representation", () => {\n    const represented = resolveAgentApiDelegatedPrincipal(credential, "spc_boundary", "dlg_boundary", [row("user", "usr_owner")]);\n    expect(represented).toMatchObject({\n      type: "user",\n      id: "usr_owner",\n      actor: { type: "agent", id: "agt_boundary" },\n      purpose: "agent_api",\n    });\n\n    expect(() => resolveAgentApiDelegatedPrincipal(credential, "spc_boundary", "dlg_boundary", [row("service", "svc_forbidden")]))\n      .toThrow(/must represent User authority/u);\n  });\n});\n''',
)

perf_path = "apps/core/test/authority-v3-performance.integration.test.ts"
perf_marker = '  it("resolves the maximum supported Delegation depth in one Authority round trip", async () => {'
perf_addition = '''  it("keeps opaque Agent represented execution bounded at two D1 round trips for 20 operations", async () => {\n    const db = (env as unknown as TestEnv).DB;\n    const suffix = crypto.randomUUID().replaceAll("-", "");\n    const userId = `usr_v3_agent_api_${suffix}`;\n    const agentId = `agt_v3_agent_api_${suffix}`;\n    const spaceId = `spc_v3_agent_api_${suffix}`;\n    const applicationId = `app_v3_agent_api_${suffix}`;\n    await seed(userId, agentId, spaceId, applicationId);\n\n    const delegationId = `dlg_v3_agent_api_${suffix}`;\n    await insertDelegation(db, {\n      id: delegationId, principalId: userId, actorId: agentId, applicationId, spaceId,\n      createdByType: "user", createdById: userId, parentId: null, remainingDepth: 0,\n    });\n\n    const model = await getRuntimeModel({ DB: db } as Bindings, "task");\n    expect(model).not.toBeNull();\n    if (!model) throw new Error("Task model missing");\n    const authenticatedAgent: Principal = {\n      type: "agent",\n      id: agentId,\n      clientId: applicationId,\n      scopes: ["resources:read", "resources:write"],\n      tokenId: `agc_v3_${suffix}`,\n      purpose: "agent_api",\n    };\n    const counter: Counter = { roundTrips: 0, batchSizes: [], preparedSql: [], resultRows: [] };\n    const bindings = { DB: countedDatabase(db, counter) } as Bindings;\n\n    const decisions = await requireModelAccessMany(\n      bindings,\n      authenticatedAgent,\n      spaceId,\n      Array.from({ length: 20 }, (_, index) => ({\n        model,\n        required: "write" as const,\n        selector: { delegationId, recordId: `rec_v3_agent_api_${suffix}_${index}` },\n      })),\n    );\n\n    expect(decisions).toHaveLength(20);\n    expect(decisions.every((decision) => decision.principal.type === "user" && decision.principal.actor?.id === agentId)).toBe(true);\n    expect(counter.roundTrips).toBe(2);\n    expect(counter.batchSizes).toEqual([1, 1]);\n    expect(counter.preparedSql).toHaveLength(2);\n    expect(counter.preparedSql.filter((sql) => sql.includes("WITH RECURSIVE chain"))).toHaveLength(1);\n  });\n\n'''
append_once(perf_path, perf_marker, perf_addition)

# ---------------------------------------------------------------------------
# Identity Platform Admin 0.4.0: explicit Agent API credential lifecycle.
# ---------------------------------------------------------------------------
replace_once("apps/identity/platform-admin.openapi.yaml", "  version: 0.3.0\n", "  version: 0.4.0\n")

platform_agent_credential_paths = '''  /internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials:\n    parameters:\n      - $ref: '#/components/parameters/ApplicationId'\n      - $ref: '#/components/parameters/AgentId'\n    get:\n      tags: [Agent Admin]\n      operationId: listPlatformAgentApiCredentials\n      description: List Agent API credential metadata only. Plaintext and hashes are never returned.\n      security: [{ applicationCredential: [], platformAdminActor: [] }]\n      responses:\n        '200': { description: Agent API credential metadata list }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '403': { $ref: '#/components/responses/Forbidden' }\n        '404': { $ref: '#/components/responses/NotFound' }\n    post:\n      tags: [Agent Admin]\n      operationId: createPlatformAgentApiCredential\n      description: Create a revocable opaque lsp_agt_* credential for the target Application + Agent Actor. It grants no Space/model/User Authority; plaintext is returned exactly once.\n      security: [{ applicationCredential: [], platformAdminActor: [] }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              additionalProperties: false\n              required: [label, scopes]\n              properties:\n                label: { type: string, minLength: 1, maxLength: 100 }\n                scopes: { type: array, uniqueItems: true, items: { type: string } }\n                expiresAt: { type: [string, 'null'], format: date-time }\n      responses:\n        '201': { description: Agent API credential created; response includes one-time write-only lsp_agt_* plaintext }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '403': { $ref: '#/components/responses/Forbidden' }\n        '404': { $ref: '#/components/responses/NotFound' }\n        '409': { description: Agent/Application binding is not active }\n        '422': { $ref: '#/components/responses/ValidationError' }\n  /internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}:\n    parameters:\n      - $ref: '#/components/parameters/ApplicationId'\n      - $ref: '#/components/parameters/AgentId'\n      - name: credentialId\n        in: path\n        required: true\n        schema: { type: string, pattern: ^agc_ }\n    patch:\n      tags: [Agent Admin]\n      operationId: updatePlatformAgentApiCredential\n      description: Reduce Agent API credential scopes, shorten expiry, or update its label. Scope/expiry authority can never be expanded.\n      security: [{ applicationCredential: [], platformAdminActor: [] }]\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema:\n              type: object\n              additionalProperties: false\n              properties:\n                label: { type: string, minLength: 1, maxLength: 100 }\n                scopes: { type: array, uniqueItems: true, items: { type: string } }\n                expiresAt: { type: [string, 'null'], format: date-time }\n      responses:\n        '200': { description: Agent API credential metadata updated }\n        '400': { $ref: '#/components/responses/InvalidRequest' }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '403': { $ref: '#/components/responses/Forbidden' }\n        '404': { $ref: '#/components/responses/NotFound' }\n        '422': { $ref: '#/components/responses/ValidationError' }\n    delete:\n      tags: [Agent Admin]\n      operationId: revokePlatformAgentApiCredential\n      description: Immediately revoke one Agent API credential without changing Agent identity, bindings or Delegations.\n      security: [{ applicationCredential: [], platformAdminActor: [] }]\n      responses:\n        '204': { description: Agent API credential revoked }\n        '401': { $ref: '#/components/responses/Unauthorized' }\n        '403': { $ref: '#/components/responses/Forbidden' }\n        '404': { $ref: '#/components/responses/NotFound' }\n'''
append_once(
    "apps/identity/platform-admin.openapi.yaml",
    "  /internal/v1/platform-admin/users:\n",
    platform_agent_credential_paths,
)

check_path = "apps/identity/scripts/check-platform-admin-openapi.mjs"
replace_once(check_path, 'document.info?.version !== "0.3.0"', 'document.info?.version !== "0.4.0"')
replace_once(
    check_path,
    '  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}",\n',
    '  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}",\n  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials",\n  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}",\n',
)
replace_once(
    check_path,
    'dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}"]?.patch, "Agent Admin update");\n',
    'dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}"]?.patch, "Agent Admin update");\n'
    'dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials"]?.get, "Agent credential list");\n'
    'dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials"]?.post, "Agent credential create");\n'
    'dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}"]?.patch, "Agent credential update");\n'
    'dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}"]?.delete, "Agent credential revoke");\n',
)
replace_once(
    check_path,
    'const tokenPatch = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}/tokens/{tokenId}"]?.patch;\n',
    '''const agentCredentialCreate = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials"]?.post;\nif (!String(agentCredentialCreate?.description ?? "").includes("lsp_agt_*")\n  || !String(agentCredentialCreate?.description ?? "").includes("no Space/model/User Authority")\n  || !String(agentCredentialCreate?.description ?? "").includes("exactly once")) {\n  throw new Error("Platform-managed Agent API credential must preserve no-authority and one-time-secret semantics");\n}\nconst agentCredentialPatch = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}"]?.patch;\nif (!String(agentCredentialPatch?.description ?? "").includes("never be expanded")) {\n  throw new Error("Platform-managed Agent API credential authority must remain reduction-only");\n}\n\nconst tokenPatch = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}/tokens/{tokenId}"]?.patch;\n''',
)

# Keep package metadata aligned with the Identity application contract released by this branch.
replace_once("apps/identity/package.json", '  "version": "0.9.0",\n', '  "version": "0.10.0",\n')

# Exercise the real Platform Admin credential lifecycle with human audit attribution.
platform_test = "apps/identity/test/platform-agent-admin.integration.test.ts"
replace_once(
    platform_test,
    '    await bootstrapApplication(pair, targetId, ["profile:read"], true);\n',
    '    await bootstrapApplication(pair, targetId, ["resources:read", "resources:write"], true);\n',
)
credential_test_block = '''\n    const credentialCreated = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}/api-credentials`, {\n      method: "POST",\n      headers: adminHeaders(console.secret, console.actorToken, true),\n      body: JSON.stringify({ label: "n8n", scopes: ["resources:read", "resources:write"] }),\n    }, pair);\n    expect(credentialCreated.status).toBe(201);\n    const agentCredential = (await credentialCreated.json() as any).data;\n    expect(agentCredential.token).toMatch(/^lsp_agt_/u);\n\n    const credentialList = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}/api-credentials`, {\n      method: "GET",\n      headers: adminHeaders(console.secret, console.actorToken),\n    }, pair);\n    expect(credentialList.status).toBe(200);\n    const listedCredential = (await credentialList.json() as any).data[0];\n    expect(listedCredential.id).toBe(agentCredential.id);\n    expect(listedCredential.token).toBeUndefined();\n\n    const credentialReduced = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}/api-credentials/${agentCredential.id}`, {\n      method: "PATCH",\n      headers: adminHeaders(console.secret, console.actorToken, true),\n      body: JSON.stringify({ scopes: ["resources:read"] }),\n    }, pair);\n    expect(credentialReduced.status).toBe(200);\n    expect((await credentialReduced.json() as any).data.scopes).toEqual(["resources:read"]);\n\n    const credentialRevoked = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}/api-credentials/${agentCredential.id}`, {\n      method: "DELETE",\n      headers: adminHeaders(console.secret, console.actorToken),\n    }, pair);\n    expect(credentialRevoked.status).toBe(204);\n'''
append_once(
    platform_test,
    '    const disabled = await request(`/internal/v1/platform-admin/applications/${targetId}/agents/${created.id}`, {\n',
    credential_test_block,
)
replace_once(
    platform_test,
    '      expect.objectContaining({ operation: "agent.update", actorUserId: console.userId, targetId: created.id }),\n',
    '      expect.objectContaining({ operation: "agent.update", actorUserId: console.userId, targetId: created.id }),\n'
    '      expect.objectContaining({ operation: "agent.api_credential.create", actorUserId: console.userId, targetId: agentCredential.id }),\n'
    '      expect.objectContaining({ operation: "agent.api_credential.update", actorUserId: console.userId, targetId: agentCredential.id }),\n'
    '      expect.objectContaining({ operation: "agent.api_credential.revoke", actorUserId: console.userId, targetId: agentCredential.id }),\n',
)

# ---------------------------------------------------------------------------
# Console BFF: secure Agent credential lifecycle with sealed no-script reveal.
# ---------------------------------------------------------------------------
worker = "apps/console/worker/configuration-center.ts"
replace_once(worker,
    'type RevealPayload = { kind: "application-credential" | "service-token"; secret: string; label: string };',
    'type RevealPayload = { kind: "application-credential" | "service-token" | "agent-credential"; secret: string; label: string };',
)
replace_once(worker,
    '  revokeServiceToken: "revoke-service-token",\n',
    '  revokeServiceToken: "revoke-service-token",\n  createAgentCredential: "create-agent-api-credential",\n  updateAgentCredential: "update-agent-api-credential",\n  revokeAgentCredential: "revoke-agent-api-credential",\n',
)
replace_once(worker,
    'function validTokenId(value: string): boolean { return /^sat_[A-Za-z0-9_-]+$/u.test(value); }\n',
    'function validTokenId(value: string): boolean { return /^sat_[A-Za-z0-9_-]+$/u.test(value); }\nfunction validAgentId(value: string): boolean { return /^agt_[A-Za-z0-9_-]+$/u.test(value); }\nfunction validAgentCredentialId(value: string): boolean { return /^agc_[A-Za-z0-9_-]+$/u.test(value); }\n',
)
replace_once(worker,
    '''function sanitizeToken(data: JsonRecord): JsonRecord {\n  return allowlist(data, ["id", "principalId", "displayPrefix", "lastFour", "label", "scopes", "audience", "expiresAt", "createdAt", "createdByUserId", "lastUsedAt", "revokedAt"]);\n}\n''',
    '''function sanitizeToken(data: JsonRecord): JsonRecord {\n  return allowlist(data, ["id", "principalId", "displayPrefix", "lastFour", "label", "scopes", "audience", "expiresAt", "createdAt", "createdByUserId", "lastUsedAt", "revokedAt"]);\n}\n\nfunction sanitizeAgentCredential(data: JsonRecord): JsonRecord {\n  return allowlist(data, ["id", "agentId", "applicationId", "displayPrefix", "lastFour", "label", "scopes", "audience", "status", "expiresAt", "createdAt", "createdByUserId", "lastUsedAt", "revokedAt", "revokedByUserId"]);\n}\n''',
)
replace_once(worker,
    '    if ((kind !== "application-credential" && kind !== "service-token") || !secret || !label) return null;\n    if (kind === "application-credential" && !secret.startsWith("lsa_")) return null;\n    if (kind === "service-token" && !secret.startsWith("lsp_svc_")) return null;\n',
    '    if ((kind !== "application-credential" && kind !== "service-token" && kind !== "agent-credential") || !secret || !label) return null;\n    if (kind === "application-credential" && !secret.startsWith("lsa_")) return null;\n    if (kind === "service-token" && !secret.startsWith("lsp_svc_")) return null;\n    if (kind === "agent-credential" && !secret.startsWith("lsp_agt_")) return null;\n',
)
replace_once(worker,
    '  const kindLabel = payload.kind === "application-credential" ? "Application credential" : "Service API Token";\n',
    '  const kindLabel = payload.kind === "application-credential" ? "Application credential" : payload.kind === "service-token" ? "Service API Token" : "Agent API credential";\n',
)

agent_worker_functions = r'''async function listAgentCredentials(request: Request, env: Env, applicationId: string, agentId: string): Promise<Response> {
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials`, {
    headers: identityHeaders(context),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "AGENT_CREDENTIAL_LIST_FAILED", "Agent API credential metadata lookup failed");
  const rows = dataArray(result.payload);
  return rows ? json({ data: rows.filter(isRecord).map(sanitizeAgentCredential) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent credential metadata", 502, requestId(request));
}

async function createAgentCredential(request: Request, env: Env, applicationId: string, agentId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.createAgentCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["label", "scopes", "expiresAt", "confirmApplicationId", "confirmAgentId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId) {
    return failure("CONFIRMATION_REQUIRED", "Agent credential creation requires exact application and Agent confirmation", 422, requestId(request));
  }
  const label = stringValue(body.label)?.trim() ?? "";
  const scopes = normalizeScopes(body.scopes);
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : undefined;
  if (!label || label.length > 100 || !scopes || expiresAt === undefined || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) {
    return failure("VALIDATION_ERROR", "Agent credential fields are invalid", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials`, {
    method: "POST", headers: identityHeaders(context, true), body: JSON.stringify({ label, scopes, expiresAt }),
  });
  if (result.response.status !== 201) return upstreamFailure(request, result, "AGENT_CREDENTIAL_CREATE_FAILED", "Agent API credential creation failed");
  const created = dataRecord(result.payload);
  const secret = created ? stringValue(created.token) : null;
  if (!created || !secret?.startsWith("lsp_agt_")) return failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity did not return a valid one-time Agent API credential", 502, requestId(request));
  let path: string;
  try { path = await revealPath(env, { kind: "agent-credential", secret, label: `${label} (${agentId})` }); }
  catch { return failure("CREDENTIAL_REVEAL_HANDOFF_FAILED", "Agent API credential was created but its secure reveal handoff could not be sealed. Revoke it and create a replacement.", 502, requestId(request)); }
  return json({ data: { credential: sanitizeAgentCredential(created), revealPath: path } }, 201);
}

async function updateAgentCredential(request: Request, env: Env, applicationId: string, agentId: string, credentialId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.updateAgentCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const allowed = new Set(["label", "scopes", "expiresAt", "confirmApplicationId", "confirmAgentId", "confirmCredentialId"]);
  if (Object.keys(body).some((key) => !allowed.has(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId || body.confirmCredentialId !== credentialId) {
    return failure("CONFIRMATION_REQUIRED", "Agent credential update requires exact application, Agent and credential confirmation", 422, requestId(request));
  }
  const patch: JsonRecord = {};
  if (body.label !== undefined) {
    const label = stringValue(body.label)?.trim() ?? "";
    if (!label || label.length > 100) return failure("VALIDATION_ERROR", "label must contain 1-100 characters", 422, requestId(request));
    patch.label = label;
  }
  if (body.scopes !== undefined) {
    const scopes = normalizeScopes(body.scopes);
    if (!scopes) return failure("VALIDATION_ERROR", "scopes are invalid", 422, requestId(request));
    patch.scopes = scopes;
  }
  if (body.expiresAt !== undefined) {
    const expiresAt = body.expiresAt === null || body.expiresAt === "" ? null : typeof body.expiresAt === "string" ? body.expiresAt : undefined;
    if (expiresAt === undefined || (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt)))) return failure("VALIDATION_ERROR", "expiresAt must be ISO date-time or null", 422, requestId(request));
    patch.expiresAt = expiresAt;
  }
  if (!Object.keys(patch).length) return failure("INVALID_REQUEST", "At least one mutable Agent credential field is required", 400, requestId(request));
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials/${encodeURIComponent(credentialId)}`, {
    method: "PATCH", headers: identityHeaders(context, true), body: JSON.stringify(patch),
  });
  if (result.response.status !== 200) return upstreamFailure(request, result, "AGENT_CREDENTIAL_UPDATE_FAILED", "Agent API credential update failed");
  const updated = dataRecord(result.payload);
  return updated ? json({ data: sanitizeAgentCredential(updated) }) : failure("UPSTREAM_RESPONSE_INVALID", "LifeSpace Identity returned invalid Agent credential metadata", 502, requestId(request));
}

async function revokeAgentCredential(request: Request, env: Env, applicationId: string, agentId: string, credentialId: string): Promise<Response> {
  const guard = exactSameOriginMutation(request, intents.revokeAgentCredential);
  if (guard) return guard;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["confirmApplicationId", "confirmAgentId", "confirmCredentialId"].includes(key)) || body.confirmApplicationId !== applicationId || body.confirmAgentId !== agentId || body.confirmCredentialId !== credentialId) {
    return failure("CONFIRMATION_REQUIRED", "Agent credential revocation requires exact application, Agent and credential confirmation", 422, requestId(request));
  }
  const context = await requireIdentityAdminContext(request, env);
  if (context instanceof Response) return context;
  const result = await serviceRequest(env.IDENTITY, env.IDENTITY_BASE_URL, `/internal/v1/platform-admin/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agentId)}/api-credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE", headers: identityHeaders(context),
  });
  if (result.response.status !== 204) return upstreamFailure(request, result, "AGENT_CREDENTIAL_REVOKE_FAILED", "Agent API credential revocation failed");
  return json({ data: { applicationId, agentId, credentialId, revoked: true } });
}

'''
append_once(worker, "function parsePath(pathname: string):", agent_worker_functions)

replace_once(worker,
    'function parsePath(pathname: string): { applicationId: string; credentialId?: string; principalId?: string; tokenId?: string; resource: "credentials" | "principals" | "tokens" } | null {\n',
    'function parsePath(pathname: string): { applicationId: string; credentialId?: string; principalId?: string; tokenId?: string; agentId?: string; agentCredentialId?: string; resource: "credentials" | "principals" | "tokens" | "agent-credentials" } | null {\n',
)
replace_once(worker,
    '''  match = /^\\/api\\/credential-governance\\/applications\\/([^/]+)\\/service-principals(?:\\/([^/]+))?(?:\\/tokens(?:\\/([^/]+))?)?$/u.exec(pathname);\n  if (!match) return null;\n''',
    '''  match = /^\\/api\\/credential-governance\\/applications\\/([^/]+)\\/agents\\/([^/]+)\\/api-credentials(?:\\/([^/]+))?$/u.exec(pathname);\n  if (match) {\n    try {\n      const applicationId = decodeURIComponent(match[1]);\n      const agentId = decodeURIComponent(match[2]);\n      const agentCredentialId = match[3] ? decodeURIComponent(match[3]) : undefined;\n      if (!validApplicationId(applicationId) || !validAgentId(agentId) || (agentCredentialId && !validAgentCredentialId(agentCredentialId))) return null;\n      return { applicationId, agentId, agentCredentialId, resource: "agent-credentials" };\n    } catch { return null; }\n  }\n  match = /^\\/api\\/credential-governance\\/applications\\/([^/]+)\\/service-principals(?:\\/([^/]+))?(?:\\/tokens(?:\\/([^/]+))?)?$/u.exec(pathname);\n  if (!match) return null;\n''',
)
replace_once(worker,
    '''  if (target.resource === "principals") {\n''',
    '''  if (target.resource === "agent-credentials" && target.agentId) {\n    if (request.method === "GET" && !target.agentCredentialId) return listAgentCredentials(request, env, target.applicationId, target.agentId);\n    if (request.method === "POST" && !target.agentCredentialId) return createAgentCredential(request, env, target.applicationId, target.agentId);\n    if (request.method === "PATCH" && target.agentCredentialId) return updateAgentCredential(request, env, target.applicationId, target.agentId, target.agentCredentialId);\n    if (request.method === "DELETE" && target.agentCredentialId) return revokeAgentCredential(request, env, target.applicationId, target.agentId, target.agentCredentialId);\n  }\n  if (target.resource === "principals") {\n''',
)

# Console static boundary gates explicitly cover the new route and secret type.
console_check = "apps/console/scripts/check-credential-governance-boundary.mjs"
replace_once(console_check,
    '  ["Service API Token route", "/tokens"],\n',
    '  ["Service API Token route", "/tokens"],\n  ["Agent API credential route", "/api-credentials"],\n',
)
replace_once(console_check,
    '  ["token target confirmation", "confirmTokenId"],\n',
    '  ["token target confirmation", "confirmTokenId"],\n  ["Agent target confirmation", "confirmAgentId"],\n  ["Agent credential target confirmation", "confirmCredentialId"],\n',
)
replace_once(console_check,
    '  ["token response allowlist", "sanitizeToken"],\n',
    '  ["token response allowlist", "sanitizeToken"],\n  ["Agent credential response allowlist", "sanitizeAgentCredential"],\n',
)
replace_once(console_check,
    '  ["one-time token validation", "secret.startsWith(\\"lsp_svc_\\")"],\n',
    '  ["one-time token validation", "secret.startsWith(\\"lsp_svc_\\")"],\n  ["one-time Agent credential validation", "secret.startsWith(\\"lsp_agt_\\")"],\n',
)

# ---------------------------------------------------------------------------
# Console UI: Agent identity -> credential metadata/lifecycle.
# ---------------------------------------------------------------------------
write(
    "apps/console/src/AgentCredentialsDialog.tsx",
    '''import { useEffect, useState } from "react";\nimport "./credential-governance.css";\n\ntype ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };\ntype DataEnvelope<T> = { data: T };\n\nexport type AgentCredentialTarget = { id: string; displayName: string };\n\ntype AgentCredential = {\n  id: string;\n  agentId: string;\n  applicationId: string;\n  displayPrefix: string;\n  lastFour: string;\n  label: string;\n  scopes: string[];\n  audience: string;\n  status: "active" | "revoked";\n  expiresAt: string | null;\n  createdAt: string;\n  lastUsedAt: string | null;\n  revokedAt: string | null;\n};\n\nclass AgentCredentialError extends Error {\n  constructor(message: string, readonly code?: string, readonly requestId?: string) {\n    super(message);\n    this.name = "AgentCredentialError";\n  }\n}\n\nasync function readData<T>(response: Response): Promise<T> {\n  const payload = await response.json().catch(() => null) as DataEnvelope<T> | ErrorEnvelope | null;\n  if (!response.ok) {\n    const error = payload && "error" in payload ? payload.error : undefined;\n    throw new AgentCredentialError(error?.message ?? `Request failed with HTTP ${response.status}`, error?.code, error?.requestId);\n  }\n  if (!payload || !("data" in payload)) throw new AgentCredentialError("Console BFF response did not contain data", "INVALID_BFF_RESPONSE");\n  return payload.data;\n}\n\nasync function get<T>(path: string): Promise<T> {\n  return readData<T>(await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }));\n}\n\nasync function mutate<T>(path: string, method: "POST" | "PATCH" | "DELETE", intent: string, body: unknown): Promise<T> {\n  return readData<T>(await fetch(path, {\n    method,\n    credentials: "same-origin",\n    headers: { accept: "application/json", "content-type": "application/json", "x-lifespace-console-intent": intent },\n    body: JSON.stringify(body),\n  }));\n}\n\nfunction parseScopes(value: string): string[] {\n  return [...new Set(value.split(/[\\s,]+/u).map((item) => item.trim()).filter(Boolean))];\n}\n\nfunction inputDateTime(value: string | null): string {\n  if (!value) return "";\n  const date = new Date(value);\n  if (Number.isNaN(date.getTime())) return "";\n  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);\n  return local.toISOString().slice(0, 16);\n}\n\nfunction isoDateTime(value: string): string | null {\n  if (!value) return null;\n  const date = new Date(value);\n  return Number.isNaN(date.getTime()) ? null : date.toISOString();\n}\n\nexport default function AgentCredentialsDialog({ applicationId, agent, onClose }: { applicationId: string; agent: AgentCredentialTarget; onClose: () => void }) {\n  const [items, setItems] = useState<AgentCredential[]>([]);\n  const [loading, setLoading] = useState(true);\n  const [busy, setBusy] = useState(false);\n  const [error, setError] = useState<unknown>();\n  const [revealPath, setRevealPath] = useState<string>();\n  const [editing, setEditing] = useState<AgentCredential>();\n  const [label, setLabel] = useState("n8n");\n  const [scopes, setScopes] = useState("resources:read\\nresources:write");\n  const [expiresAt, setExpiresAt] = useState("");\n\n  const basePath = `/api/credential-governance/applications/${encodeURIComponent(applicationId)}/agents/${encodeURIComponent(agent.id)}/api-credentials`;\n\n  async function load() {\n    setLoading(true); setError(undefined);\n    try { setItems(await get<AgentCredential[]>(basePath)); }\n    catch (cause) { setError(cause); }\n    finally { setLoading(false); }\n  }\n\n  useEffect(() => { void load(); }, [applicationId, agent.id]);\n\n  function reset() {\n    setEditing(undefined); setLabel("n8n"); setScopes("resources:read\\nresources:write"); setExpiresAt("");\n  }\n\n  function beginReduce(item: AgentCredential) {\n    setEditing(item); setLabel(item.label); setScopes(item.scopes.join("\\n")); setExpiresAt(inputDateTime(item.expiresAt)); setRevealPath(undefined);\n  }\n\n  async function save() {\n    setBusy(true); setError(undefined); setRevealPath(undefined);\n    try {\n      const values = parseScopes(scopes);\n      if (editing) {\n        await mutate<AgentCredential>(`${basePath}/${encodeURIComponent(editing.id)}`, "PATCH", "update-agent-api-credential", {\n          label: label.trim(), scopes: values, expiresAt: isoDateTime(expiresAt),\n          confirmApplicationId: applicationId, confirmAgentId: agent.id, confirmCredentialId: editing.id,\n        });\n      } else {\n        const result = await mutate<{ credential: AgentCredential; revealPath: string }>(basePath, "POST", "create-agent-api-credential", {\n          label: label.trim(), scopes: values, expiresAt: isoDateTime(expiresAt),\n          confirmApplicationId: applicationId, confirmAgentId: agent.id,\n        });\n        setRevealPath(result.revealPath);\n      }\n      reset();\n      await load();\n    } catch (cause) { setError(cause); }\n    finally { setBusy(false); }\n  }\n\n  async function revoke(item: AgentCredential) {\n    if (!window.confirm(`确认撤销 Agent credential ${item.id}（${item.displayPrefix}…${item.lastFour}）？使用它的 n8n/adapter 会立即无法认证。`)) return;\n    setBusy(true); setError(undefined); setRevealPath(undefined);\n    try {\n      await mutate<{ revoked: true }>(`${basePath}/${encodeURIComponent(item.id)}`, "DELETE", "revoke-agent-api-credential", {\n        confirmApplicationId: applicationId, confirmAgentId: agent.id, confirmCredentialId: item.id,\n      });\n      await load();\n    } catch (cause) { setError(cause); }\n    finally { setBusy(false); }\n  }\n\n  const active = items.filter((item) => item.status === "active" && !item.revokedAt);\n  const history = items.filter((item) => item.status !== "active" || item.revokedAt);\n  const displayError = error instanceof AgentCredentialError ? error : error instanceof Error ? new AgentCredentialError(error.message) : undefined;\n\n  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>\n    <section className="cp-dialog cgp-dialog" role="dialog" aria-modal="true" aria-label="Agent API credentials">\n      <header className="cp-dialog-header"><div><div className="cp-eyebrow">Agent credential governance</div><h2>Agent API credentials</h2><p>{agent.displayName} · {agent.id}</p></div><button className="cp-icon-button" onClick={onClose} aria-label="关闭">×</button></header>\n      <div className="cp-dialog-body">\n        <div className="cgp-warning"><strong>Credential ≠ Authority</strong><span>`lsp_agt_*` 只认证当前 Application + Agent Actor；直接模式只能使用 Agent 自己已有的 Authority，User 模式必须另外携带当前 `dlg_*`。</span></div>\n        {revealPath && <div className="cgp-reveal-notice"><div><strong>一次性 Agent credential 已生成</strong><span>明文没有进入 React/JSON。请在 60 秒内打开隔离 reveal 页面并保存到 n8n/adapter。</span></div><a href={revealPath} target="_blank" rel="noreferrer" onClick={() => setRevealPath(undefined)}>Open one-time secret</a></div>}\n        <div className="cgp-editor">\n          <div className="cgp-form-grid"><label className="cp-field"><span>Label</span><input maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} /></label><label className="cp-field"><span>Expires at (optional)</span><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} /></label></div>\n          <label className="cp-field"><span>Scopes</span><textarea className="cgp-scopes" value={scopes} onChange={(event) => setScopes(event.target.value)} spellCheck={false} /><small>必须位于 Application scope ceiling 内。已有 credential 只能收窄 scopes / 缩短 expiry，Identity 会再次强制校验。</small></label>\n          <div className="cgp-actions">{editing && <button className="cp-secondary" disabled={busy} onClick={reset}>取消收窄</button>}<button className="cp-primary" disabled={busy || !label.trim() || !parseScopes(scopes).length} onClick={() => void save()}>{editing ? "Save reduction" : "Create credential"}</button></div>\n        </div>\n        {displayError && <div className="cp-notice cp-error"><strong>{displayError.code ?? "操作失败"}</strong><span>{displayError.message}</span>{displayError.requestId && <small>requestId: {displayError.requestId}</small>}</div>}\n        <div className="cgp-section-title"><div><strong>Active credentials</strong><span>{active.length}</span></div></div>\n        <div className="cgp-list">{loading ? <div className="cp-loading">正在读取 Agent credential metadata…</div> : active.length ? active.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.label}</strong><code>{item.displayPrefix}…{item.lastFour}</code><small>{item.scopes.join(" · ")} · {item.expiresAt ? `expires ${new Date(item.expiresAt).toLocaleString()}` : "no expiry"}</small></div><div className="cgp-actions"><button disabled={busy} onClick={() => beginReduce(item)}>Reduce</button><button className="cgp-danger" disabled={busy} onClick={() => void revoke(item)}>Revoke</button></div></div>) : <div className="cp-loading">当前没有 active Agent credential。</div>}</div>\n        {!!history.length && <><div className="cgp-section-title"><div><strong>Revoked history</strong><span>{history.length}</span></div></div><div className="cgp-list cgp-muted">{history.map((item) => <div className="cgp-row" key={item.id}><div><strong>{item.label}</strong><code>{item.displayPrefix}…{item.lastFour}</code><small>revoked {item.revokedAt ? new Date(item.revokedAt).toLocaleString() : item.status}</small></div></div>)}</div></>}\n      </div>\n      <footer className="cp-dialog-footer"><button className="cp-secondary" onClick={onClose}>关闭</button></footer>\n    </section>\n  </div>;\n}\n''',
)

agent_ui = "apps/console/src/AgentIdentitiesDialog.tsx"
replace_once(agent_ui,
    'import { useEffect, useState } from "react";\n',
    'import { useEffect, useState } from "react";\nimport AgentCredentialsDialog from "./AgentCredentialsDialog";\n',
)
replace_once(agent_ui,
    '  const [editing, setEditing] = useState<AgentIdentity>();\n',
    '  const [editing, setEditing] = useState<AgentIdentity>();\n  const [credentialAgent, setCredentialAgent] = useState<AgentIdentity>();\n',
)
replace_once(agent_ui,
    '  return <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>\n',
    '  return <>\n  <div className="cp-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>\n',
)
replace_once(agent_ui,
    '<small>global {agent.status} · binding {agent.binding.status}</small></div><button disabled={busy} onClick={() => beginEdit(agent)}>Edit</button></div>)',
    '<small>global {agent.status} · binding {agent.binding.status}</small></div><div className="acp-inline-form"><button disabled={busy} onClick={() => setCredentialAgent(agent)}>Credentials</button><button disabled={busy} onClick={() => beginEdit(agent)}>Edit</button></div></div>)',
)
replace_once(agent_ui,
    '    </section>\n  </div>;\n}',
    '    </section>\n  </div>\n  {credentialAgent && <AgentCredentialsDialog applicationId={applicationId} agent={credentialAgent} onClose={() => setCredentialAgent(undefined)} />}\n  </>;\n}',
)

# ---------------------------------------------------------------------------
# Normative docs and AGENTS: canonical prefixes + #307 boundary.
# ---------------------------------------------------------------------------
arch = "docs/architecture.md"
replace_once(arch, "  -> opaque lsp_pat_* Service API Token\n", "  -> opaque lsp_svc_* Service API Token\n")
replace_once(arch,
    '''Owner-controlled automation / script / protocol adapter / backend\n  -> opaque lsp_svc_* Service API Token\n  -> LifeSpace Core\n\nThird-party or policy-controlled service\n''',
    '''Owner-controlled automation / script / protocol adapter / backend\n  -> opaque lsp_svc_* Service API Token\n  -> LifeSpace Core\n\nAgent adapter / n8n User Delegation mode\n  -> opaque lsp_agt_* Agent API credential authenticates Application + Agent Actor\n  -> explicit dlg_* selects current User authority when User/Agent execution is intended\n  -> LifeSpace Core\n\nThird-party or policy-controlled service\n''',
)
replace_once(arch,
    "Browser JavaScript must not receive `lsa_*`, `lsp_pat_*`, bootstrap secrets or equivalent backend credentials.",
    "Browser JavaScript must not receive `lsa_*`, `lsp_svc_*`, legacy `lsp_pat_*`, `lsp_agt_*`, bootstrap secrets or equivalent backend credentials.",
)
replace_once(arch,
    "- opaque, revocable `lsp_pat_*` Service API Tokens for owner-controlled trusted workloads;",
    "- opaque, revocable `lsp_svc_*` Service API Tokens for owner-controlled trusted workloads (`lsp_pat_*` remains legacy input only);",
)

service_doc = "docs/service-authentication.md"
agent_section = '''## Opaque Agent API credential\n\nA trusted application may issue an opaque `lsp_agt_*` credential for one stable `agt_*` identity. The credential authenticates exactly **Application + Agent Actor** and is accepted by Core through current Identity introspection. It is not a User credential, not a Service API Token, and does not grant Space/model/User authority by itself.\n\nTwo execution modes are intentionally distinct:\n\n```text\nDirect Agent\n  lsp_agt_* -> Principal=Agent / Actor=Agent\n  -> only the Agent's own current Data Grant / model authority may be used\n\nUser Delegation\n  lsp_agt_* + explicit dlg_*\n  -> Core resolves the current Delegation chain\n  -> Principal=User / Actor=Agent\n  -> the adapter never supplies principalUserId\n```\n\nOpaque Agent credential represented mode is deliberately limited to **User/Agent**. A `dlg_*` cannot use `lsp_agt_*` to turn the same credential into a Service/Agent or arbitrary Principal execution context. Direct Agent and represented User operations also cannot be mixed inside one batch, and all represented items in one batch must resolve to the same Root User Principal.\n\nIdentity owns the credential hash, Agent/Application binding, scope ceiling, expiry, last-used metadata and revocation. Existing credential scopes/expiry are reduction-only. Core owns Delegation, Data Grant, Application × Model Access and execution-time business Authority. Successful opaque Agent authentication adds one current-state Identity Service Binding read; represented execution adds one bounded Delegation-chain D1 read per business request/batch, not per item.\n\nLifeSpace Console may create/list/reduce/revoke these credentials through Identity Platform Admin. Plaintext is returned exactly once by Identity, immediately sealed by the Console BFF into the existing <=60-second AES-GCM no-script reveal handoff, and is never returned to React as ordinary JSON.\n\n'''
append_once(service_doc, "## Delegated Agent execution is not service automation\n", agent_section)
replace_once(service_doc, "Identity Platform Admin `0.3.0` therefore exposes", "Identity Platform Admin `0.4.0` therefore exposes")
replace_once(service_doc, "Value: Bearer lsp_pat_xxxxx", "Value: Bearer lsp_svc_xxxxx")
replace_once(service_doc,
    "`lsa_*`, `lsp_svc_*`, legacy `lsp_pat_*` and OAuth client credentials must never be exposed to browser/Mini Program/mobile client code.",
    "`lsa_*`, `lsp_svc_*`, legacy `lsp_pat_*`, `lsp_agt_*` and OAuth client credentials must never be exposed to browser/Mini Program/mobile client code.",
)

permissions = "docs/permissions.md"
perm_text = read(permissions)
perm_text = perm_text.replace("Core admin:     Console service principal / lsp_pat_* or equivalent service JWT", "Core admin:     Console service principal / lsp_svc_* (legacy lsp_pat_* accepted) or equivalent service JWT")
if "Opaque Agent API credential boundary" not in perm_text:
    perm_text += '''\n\n## Opaque Agent API credential boundary\n\n`lsp_agt_*` authenticates an active registered Application + active Agent Actor only. With no Delegation selector, Core evaluates direct Agent Authority. With an explicit current `dlg_*`, Core may resolve only a User Root Principal and executes as `Principal=User / Actor=Agent`; the adapter does not submit a `principalUserId`. Service/Agent or other represented Principal types are rejected on this credential profile. Credential scope, Application × Model Access, current User Authority and current Delegation all remain intersected at execution.\n'''
write(permissions, perm_text)

contracts = "docs/contracts.md"
contract_text = read(contracts)
contract_text = contract_text.replace("## Identity 0.9.0 / Platform Admin 0.3.0 — canonical Service API Token prefix", "## Identity 0.10.0 / Platform Admin 0.4.0 — first-class Agent API credential")
contract_text = contract_text.replace("Identity Application Contract** — `apps/identity/openapi.yaml`, used by ordinary user/application authentication, profile, trusted application exchange, Cloudflare Access principal linking and application-owned service authentication. Its current version is `0.6.0`; 0.6.0 adds first-class Agent identity and Core-only delegated Agent execution-token issuance.", "Identity Application Contract** — `apps/identity/openapi.yaml`, used by ordinary user/application authentication, profile, trusted application exchange, Cloudflare Access principal linking, service authentication and application-owned Agent authentication. Its current version is `0.10.0`; 0.10.0 adds revocable opaque `lsp_agt_*` Agent API credentials without granting Authority by credential possession.")
contract_text = contract_text.replace("Identity Platform Admin Contract** — `apps/identity/platform-admin.openapi.yaml`, used only by the LifeSpace Console and approved break-glass/platform-control workflows. Its current version is `0.2.0`; 0.2.0 adds Application-scoped Agent identity governance while preserving the existing dual actor/executor control-plane boundary.", "Identity Platform Admin Contract** — `apps/identity/platform-admin.openapi.yaml`, used only by the LifeSpace Console and approved break-glass/platform-control workflows. Its current version is `0.4.0`; 0.4.0 adds Agent API credential lifecycle governance while preserving the existing dual actor/executor control-plane boundary.")
contract_text = contract_text.replace("Identity Platform Admin Contract: 0.3.0", "Identity Platform Admin Contract: 0.4.0")
contract_text = contract_text.replace("Identity Platform Admin is `0.3.0`; Core Platform Admin is `0.3.0`.", "Identity Platform Admin is `0.4.0`; Core Platform Admin is `0.3.0`.")
contract_text = contract_text.replace("One-time `lsa_*` and `lsp_pat_*` plaintext fields remain write-only contract data", "One-time `lsa_*`, `lsp_svc_*` and `lsp_agt_*` plaintext fields remain write-only contract data; legacy `lsp_pat_*` is accepted input only")
write(contracts, contract_text)

# AGENTS: new machine-credential class must remain server-side and authority-neutral.
root_agents = "AGENTS.md"
root_text = read(root_agents)
root_text = root_text.replace("Browser JavaScript/Mini Program/downloadable clients must never receive `lsa_*`, `lsp_pat_*`, bootstrap secrets or signing keys.", "Browser JavaScript/Mini Program/downloadable clients must never receive `lsa_*`, `lsp_svc_*`, legacy `lsp_pat_*`, `lsp_agt_*`, bootstrap secrets or signing keys.")
if "Agent API credential" not in root_text:
    root_text += '''\n\n### Agent API credential invariant\n\n- `lsp_agt_*` authenticates Application + Agent Actor only; it is never proof of User Authority.\n- Direct use is `Principal=Agent / Actor=Agent`. Represented use requires an explicit current `dlg_*` and may resolve only `Principal=User / Actor=Agent`; adapters must not supply `principalUserId`.\n- Agent credential scope/expiry updates are reduction-only and plaintext is one-time-only.\n'''
write(root_agents, root_text)

identity_agents = "apps/identity/AGENTS.md"
identity_text = read(identity_agents)
if "opaque `lsp_agt_*`" not in identity_text:
    identity_text = identity_text.replace("- service principals, canonical opaque `lsp_svc_*` Service API Tokens, legacy `lsp_pat_*` migration tokens and optional OAuth `client_credentials`;", "- service principals, canonical opaque `lsp_svc_*` Service API Tokens, legacy `lsp_pat_*` migration tokens and optional OAuth `client_credentials`;\n- stable Agent identities and opaque `lsp_agt_*` Agent API credentials that bind Application + Agent Actor but grant no Space/model/User Authority;")
write(identity_agents, identity_text)

core_agents = "apps/core/AGENTS.md"
core_text = read(core_agents)
core_text = core_text.replace("`lsp_pat_*`", "`lsp_svc_*` / legacy `lsp_pat_*`")
if "lsp_agt_*" not in core_text:
    core_text += '''\n\n### Agent API credential execution\n\n- `lsp_agt_*` is introspected through Identity and normalizes initially to direct `agent` Principal context.\n- An explicit `dlg_*` may resolve represented execution only to `Principal=user / Actor=agent`; no caller-supplied user identity is trusted.\n- Keep Delegation resolution set-wise/bounded for Batch; never add per-item Identity/D1 waterfalls.\n'''
write(core_agents, core_text)

console_agents = "apps/console/AGENTS.md"
console_text = read(console_agents)
console_text = console_text.replace("Browser JavaScript must never receive `lsa_*`, `lsp_pat_*`, bootstrap secrets, OAuth client secrets", "Browser JavaScript must never receive `lsa_*`, `lsp_svc_*`, legacy `lsp_pat_*`, `lsp_agt_*`, bootstrap secrets, OAuth client secrets")
if "Agent API credential plaintext" not in console_text:
    console_text += '''\n\n### Agent API credential reveal\n\n- Agent API credential plaintext is handled exactly like other one-time target credentials: Identity returns it once to the Console BFF, the BFF seals it into the <=60-second AES-GCM no-script reveal handoff, and React receives only metadata plus the opaque reveal locator.\n- Console may create/list/reduce/revoke Agent credentials but must never treat credential possession as Space/model/User Authority.\n'''
write(console_agents, console_text)

# A few human-facing current-state docs still used the pre-#311 prefix as if canonical.
for path in ["apps/console/README.md", "docs/console-target-credential-reveal.md", "docs/lifespace-console-mvp.md", "README.md"]:
    text = read(path)
    text = text.replace("lsp_pat_*", "lsp_svc_*")
    write(path, text)

# ---------------------------------------------------------------------------
# Contract stability: update only the candidate Identity Platform Admin source digest.
# Stable operation-group digests remain untouched.
# ---------------------------------------------------------------------------
def yaml_operations(text: str) -> list[str]:
    lines = text.splitlines()
    try:
        index = lines.index("paths:") + 1
    except ValueError:
        raise SystemExit("platform-admin.openapi.yaml has no paths section")
    current = None
    operations: list[str] = []
    for line in lines[index:]:
        if re.match(r"^[A-Za-z0-9_-]+:\s*$", line):
            break
        match = re.match(r"^  (/.*):\s*$", line)
        if match:
            current = match.group(1)
            continue
        method = re.match(r"^    (get|post|put|patch|delete|options|head|trace):\s*$", line, re.I)
        if method and current:
            operations.append(f"{method.group(1).upper()} {current}")
    return sorted(set(operations))

baseline_path = ROOT / "docs/contract-stability-baseline.json"
baseline = json.loads(baseline_path.read_text())
ops = yaml_operations(read("apps/identity/platform-admin.openapi.yaml"))
digest = "sha256:" + hashlib.sha256("\n".join(ops).encode()).hexdigest()
for source in baseline["contractSources"]:
    if source["id"] == "identity-platform-admin":
        source["operationSetSha256"] = digest
        break
else:
    raise SystemExit("identity-platform-admin contract source missing from stability baseline")
baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n")

print("Issue #307 phase B closeout applied")

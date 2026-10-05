from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, got {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

# ---------------------------------------------------------------------------
# Real Core staging: prove opaque Agent credential direct + User/Agent dlg_*.
# ---------------------------------------------------------------------------
authority = "infra/scripts/verify-staging-authority-v3.mjs"
replace_once(
    authority,
    '''async function createTask(bearer, name, delegationId) {\n''',
    '''async function issueAgentApiCredential(agentId, label) {\n  const result = await request(identityBase, `/internal/v1/agents/${encodeURIComponent(agentId)}/api-credentials`, {\n    method: "POST",\n    bearer: applicationSecret,\n    body: {\n      label: `Staging ${label} ${runId}`,\n      scopes: ["resources:read", "resources:write"],\n      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),\n    },\n  });\n  const data = expectStatus(result, 201, `Agent API credential for ${agentId}`);\n  if (!data?.id?.startsWith("agc_") || !data?.token?.startsWith("lsp_agt_")) {\n    throw new Error(`Agent API credential for ${agentId} is invalid: ${JSON.stringify(data)}`);\n  }\n  console.log(`::add-mask::${data.token}`);\n  return { id: data.id, token: data.token };\n}\n\nasync function revokeAgentApiCredential(agentId, credentialId) {\n  const result = await request(identityBase, `/internal/v1/agents/${encodeURIComponent(agentId)}/api-credentials/${encodeURIComponent(credentialId)}`, {\n    method: "DELETE",\n    bearer: applicationSecret,\n  });\n  if (result.response.status !== 204 && result.response.status !== 404) {\n    throw new Error(`Agent API credential revoke failed: HTTP ${result.response.status} ${JSON.stringify(result.payload)}`);\n  }\n}\n\nasync function createTask(bearer, name, delegationId) {\n''',
)
replace_once(
    authority,
    '''let agentGrantId = "";\nlet rootDelegationId = "";\nlet rootRevoked = false;\n''',
    '''let agentGrantId = "";\nlet rootDelegationId = "";\nlet rootRevoked = false;\nlet opaqueAgentId = "";\nlet opaqueCredentialId = "";\nlet opaqueCredentialRevoked = false;\n''',
)
replace_once(
    authority,
    '''  const directCreate = await createTask(directAgentA, `Authority v3 direct Agent ${runId}`);\n''',
    '''  const opaque = await issueAgentApiCredential(agentA, "opaque Agent A");\n  opaqueAgentId = agentA;\n  opaqueCredentialId = opaque.id;\n\n  const opaqueDirectCreate = await createTask(opaque.token, `Authority v3 opaque direct Agent ${runId}`);\n  const opaqueDirectTask = expectStatus(opaqueDirectCreate, 201, "Opaque Direct Agent task create");\n  if (!opaqueDirectTask?.id) throw new Error("Opaque Direct Agent task create omitted record id");\n  const opaqueDirectChange = await firstChange(opaqueDirectTask.id);\n  if (\n    opaqueDirectChange.principal?.type !== "agent"\n    || opaqueDirectChange.principal?.id !== agentA\n    || opaqueDirectChange.actor?.type !== "agent"\n    || opaqueDirectChange.actor?.id !== agentA\n    || opaqueDirectChange.delegationId !== null\n  ) {\n    throw new Error(`Opaque Direct Agent governed Change attribution mismatch: ${JSON.stringify(opaqueDirectChange)}`);\n  }\n\n  const directCreate = await createTask(directAgentA, `Authority v3 direct Agent ${runId}`);\n''',
)
replace_once(
    authority,
    '''  const representedA = await issueAgentToken({\n''',
    '''  const opaqueRepresentedCreate = await createTask(\n    opaque.token,\n    `Authority v3 opaque represented User Agent ${runId}`,\n    rootDelegationId,\n  );\n  const opaqueRepresentedTask = expectStatus(opaqueRepresentedCreate, 201, "Opaque Agent User Delegation task create");\n  if (!opaqueRepresentedTask?.id) throw new Error("Opaque Agent User Delegation task create omitted record id");\n  const opaqueRepresentedChange = await firstChange(opaqueRepresentedTask.id);\n  if (\n    opaqueRepresentedChange.principal?.type !== "user"\n    || opaqueRepresentedChange.principal?.id !== userId\n    || opaqueRepresentedChange.actor?.type !== "agent"\n    || opaqueRepresentedChange.actor?.id !== agentA\n    || opaqueRepresentedChange.delegationId !== rootDelegationId\n  ) {\n    throw new Error(`Opaque Agent User Delegation governed Change attribution mismatch: ${JSON.stringify(opaqueRepresentedChange)}`);\n  }\n\n  await revokeAgentApiCredential(agentA, opaque.id);\n  opaqueCredentialRevoked = true;\n  const deniedOpaqueAfterRevoke = await createTask(opaque.token, `Must be denied after opaque credential revoke ${runId}`);\n  if (deniedOpaqueAfterRevoke.response.status !== 401) {\n    throw new Error(`Revoked Agent API credential remained usable: HTTP ${deniedOpaqueAfterRevoke.response.status} ${JSON.stringify(deniedOpaqueAfterRevoke.payload)}`);\n  }\n\n  const representedA = await issueAgentToken({\n''',
)
replace_once(
    authority,
    '''    directAgentProfileScopeDenied: true,\n    directAgentAuthority: true,\n    directAgentChangeAttribution: true,\n''',
    '''    directAgentProfileScopeDenied: true,\n    directAgentAuthority: true,\n    directAgentChangeAttribution: true,\n    opaqueAgentCredentialDirectAuthority: true,\n    opaqueAgentCredentialUserDelegation: true,\n    opaqueAgentCredentialChangeAttribution: true,\n    opaqueAgentCredentialRevocation: true,\n''',
)
replace_once(
    authority,
    '''} finally {\n  if (rootDelegationId && !rootRevoked) {\n''',
    '''} finally {\n  if (opaqueAgentId && opaqueCredentialId && !opaqueCredentialRevoked) {\n    try {\n      await revokeAgentApiCredential(opaqueAgentId, opaqueCredentialId);\n    } catch (error) {\n      console.warn(`Agent API credential cleanup failed: ${error instanceof Error ? error.message : String(error)}`);\n    }\n  }\n  if (rootDelegationId && !rootRevoked) {\n''',
)

# ---------------------------------------------------------------------------
# Real Identity Platform Admin staging: prove Agent lifecycle + reduce/revoke/audit.
# ---------------------------------------------------------------------------
config = "apps/console/scripts/verify-staging-configuration-center.mjs"
replace_once(
    config,
    '''  tokenSecret: "",\n  tokenRevoked: false,\n''',
    '''  tokenSecret: "",\n  tokenRevoked: false,\n  agentId: "",\n  agentCredentialId: "",\n  agentCredentialSecret: "",\n  agentCredentialRevoked: false,\n  agentDisabled: false,\n''',
)
replace_once(
    config,
    '''async function disablePrincipal() {\n''',
    '''async function revokeAgentCredential() {\n  if (!cleanup.targetApplicationId || !cleanup.agentId || !cleanup.agentCredentialId || cleanup.agentCredentialRevoked) return;\n  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials/${encodeURIComponent(cleanup.agentCredentialId)}`, { method: "DELETE" });\n  if (result.response.status !== 204 && result.response.status !== 404) throw new Error(`Agent credential cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);\n  cleanup.agentCredentialRevoked = true;\n}\n\nasync function disableAgent() {\n  if (!cleanup.targetApplicationId || !cleanup.agentId || cleanup.agentDisabled) return;\n  const result = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}`, {\n    method: "PATCH",\n    body: { displayName: `Disabled staging acceptance Agent ${runSuffix}`, status: "disabled" },\n  });\n  if (result.response.status !== 200 && result.response.status !== 404) throw new Error(`Agent cleanup failed: ${result.response.status} ${JSON.stringify(result.payload)}`);\n  cleanup.agentDisabled = true;\n}\n\nasync function disablePrincipal() {\n''',
)
agent_lifecycle = '''\n  const agent = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents`, {\n    method: "POST",\n    body: { displayName: `MVP acceptance Agent ${runSuffix}` },\n  }), 201, "Create target Agent identity");\n  cleanup.agentId = agent?.id ?? "";\n  if (!/^agt_[0-9A-Za-z_-]+$/u.test(cleanup.agentId)) throw new Error(`Agent id is invalid: ${cleanup.agentId}`);\n\n  const agentCredential = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials`, {\n    method: "POST",\n    body: {\n      label: `MVP acceptance Agent credential ${runSuffix}`,\n      scopes: ["resources:read", "resources:write"],\n      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),\n    },\n  }), 201, "Create target Agent API credential");\n  cleanup.agentCredentialId = agentCredential?.id ?? "";\n  cleanup.agentCredentialSecret = agentCredential?.token ?? "";\n  if (!/^agc_[0-9A-Za-z_-]+$/u.test(cleanup.agentCredentialId) || !cleanup.agentCredentialSecret.startsWith("lsp_agt_")) throw new Error("Agent API credential result is invalid");\n  mask(cleanup.agentCredentialSecret);\n\n  const reducedAgentCredential = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials/${encodeURIComponent(cleanup.agentCredentialId)}`, {\n    method: "PATCH",\n    body: { scopes: ["resources:read"], expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() },\n  }), 200, "Reduce target Agent API credential scope");\n  if (!Array.isArray(reducedAgentCredential?.scopes) || reducedAgentCredential.scopes.length !== 1 || reducedAgentCredential.scopes[0] !== "resources:read") {\n    throw new Error(`Agent credential scope reduction did not persist: ${JSON.stringify(reducedAgentCredential)}`);\n  }\n\n  const agentExpansion = await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials/${encodeURIComponent(cleanup.agentCredentialId)}`, {\n    method: "PATCH",\n    body: { scopes: ["resources:read", "resources:write"] },\n  });\n  if (agentExpansion.response.status !== 422 && agentExpansion.response.status !== 403) {\n    throw new Error(`Agent credential scope expansion should be denied, got ${agentExpansion.response.status}: ${JSON.stringify(agentExpansion.payload)}`);\n  }\n\n  const agentCredentialRows = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/agents/${encodeURIComponent(cleanup.agentId)}/api-credentials`), 200, "List Agent API credential metadata");\n  if (!Array.isArray(agentCredentialRows) || !agentCredentialRows.some((entry) => entry?.id === cleanup.agentCredentialId && entry?.scopes?.length === 1 && entry?.scopes?.[0] === "resources:read")) {\n    throw new Error("Reduced Agent API credential did not appear in metadata list");\n  }\n  if (JSON.stringify(agentCredentialRows).includes(cleanup.agentCredentialSecret)) throw new Error("Agent credential metadata list leaked plaintext");\n\n  await revokeAgentCredential();\n  await disableAgent();\n'''
replace_once(
    config,
    '''  const principal = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals`, {\n''',
    agent_lifecycle + '''\n  const principal = requireStatus(await admin(`/internal/v1/platform-admin/applications/${encodeURIComponent(cleanup.targetApplicationId)}/service-principals`, {\n''',
)
replace_once(
    config,
    '''  await revokeToken();\n  await disablePrincipal();\n''',
    '''  await revokeToken();\n  await revokeAgentCredential();\n  await disableAgent();\n  await disablePrincipal();\n''',
)
replace_once(
    config,
    '''    cleanup.principalId,\n    cleanup.tokenId,\n''',
    '''    cleanup.principalId,\n    cleanup.tokenId,\n    cleanup.agentId,\n    cleanup.agentCredentialId,\n''',
)
replace_once(
    config,
    '''  if (relevantAudit.length < 8) throw new Error(`Expected at least 8 human-attributed target audit entries, found ${relevantAudit.length}: ${JSON.stringify(relevantAudit)}`);\n  const auditSerialized = JSON.stringify(relevantAudit);\n  for (const secret of [cleanup.targetInitialSecret, cleanup.targetReplacementSecret, cleanup.tokenSecret]) {\n''',
    '''  if (relevantAudit.length < 13) throw new Error(`Expected at least 13 human-attributed target audit entries, found ${relevantAudit.length}: ${JSON.stringify(relevantAudit)}`);\n  for (const operation of ["agent.create", "agent.update", "agent.api_credential.create", "agent.api_credential.update", "agent.api_credential.revoke"]) {\n    if (!relevantAudit.some((entry) => entry?.operation === operation)) throw new Error(`Missing human-attributed ${operation} audit entry: ${JSON.stringify(relevantAudit)}`);\n  }\n  const auditSerialized = JSON.stringify(relevantAudit);\n  for (const secret of [cleanup.targetInitialSecret, cleanup.targetReplacementSecret, cleanup.tokenSecret, cleanup.agentCredentialSecret]) {\n''',
)
replace_once(
    config,
    '''    serviceTokenCreateReduceExpansionDenyRevokeProven: true,\n    auditEntriesObserved: relevantAudit.length,\n''',
    '''    serviceTokenCreateReduceExpansionDenyRevokeProven: true,\n    agentIdentityLifecycleProven: true,\n    agentCredentialCreateReduceExpansionDenyRevokeProven: true,\n    auditEntriesObserved: relevantAudit.length,\n''',
)
replace_once(
    config,
    '''} finally {\n  await bestEffort("Cleanup token", revokeToken);\n  await bestEffort("Cleanup principal", disablePrincipal);\n''',
    '''} finally {\n  await bestEffort("Cleanup token", revokeToken);\n  await bestEffort("Cleanup Agent credential", revokeAgentCredential);\n  await bestEffort("Cleanup Agent", disableAgent);\n  await bestEffort("Cleanup principal", disablePrincipal);\n''',
)

# Workflow summaries become explicit about the new real-staging coverage.
replace_once(
    ".github/workflows/staging-deploy.yml",
    "          - Agent Principal own-Authority + User→Agent→Agent bounded re-delegation/revocation: passed\n",
    "          - Agent Principal own-Authority + User→Agent→Agent bounded re-delegation/revocation: passed\n          - Opaque `lsp_agt_*` direct Agent + explicit `dlg_*` User/Agent execution + credential revocation: passed\n",
)
replace_once(
    ".github/workflows/lifespace-console-staging-deploy.yml",
    "          - Created/disabled a disposable Service Principal.\n",
    "          - Created/disabled a disposable Agent identity and created/reduced/revoked its `lsp_agt_*` credential with human audit attribution.\n          - Created/disabled a disposable Service Principal.\n",
)

print("#307 staging acceptance coverage applied")

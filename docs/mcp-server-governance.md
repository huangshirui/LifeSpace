## Native File upload / 上传附件（开发候选）

Model operation `file_upload` is explicit opt-in, shown as 上传附件 only for a published writable native file/file_list field. It adds the write Scope ceiling but not Data Grants, Create, Update, Delete, Query or file_read. Core validates current operation configuration and file field eligibility at both upload phases. Account describes the write operation and disables single-use approval for this multi-step capability. Existing Server selections remain unchanged. Generic Operations 0.5.0 and Platform Admin 0.11.0 describe the candidate; enable only after compatible Core/Adapter/Account/Console deployments.

## 2026-11-19 · Native File read / 读取附件（开发候选）

Model operations gain explicit opt-in `file_read`, selectable in Console as 读取附件 only when the published model has readable native file/file_list fields. It is a read operation and does not imply Get, Query, write, or any Grant. Existing selections are unchanged. Core validates the selection and revalidates at execution; Account previews the operation as read-only. No separate File ACL, migration, health-specific rule, or External provider transfer capability is introduced. See Generic Operations 0.4.0 and Platform Admin 0.10.0 candidate contracts.

# MCP Server simplified configuration (LifeSpace)

Status: V7 Staging candidate · Core Platform Admin 0.8.0 · Schema 78.

## 中文结论

领域 MCP Server 是平台级可直接编辑的能力配置，而非一个需要版本发布的制品。
新建时填写名称、可选描述，并选定业务模型或 Person Directory 及其操作；创建成功立即启用。
详情页「保存修改」即更新当前配置，另可单独「启用／停用」。
不提供 Draft/Publish、v1/v2 配置发布历史或回滚按钮，只保留内部 revision 用来防止并发覆盖和平台管理员审计。

## Public URL

Agreed planned external address: https://core.aisr.online/mcp/{serverId}.
The stable Core-generated mcp_* ID is the URL key. There is no /v1/ path segment: MCP protocol version is negotiated within the protocol, and internal configuration revision is unrelated.
The public domain is an integration entrance; actual MCP protocol execution remains in lifespace-adapters and is not implemented or activated by this configuration change.

## Configuration

The canonical JSON configuration has:
- models: array of published Model Registry modelKey plus explicit operations (get/query/create/update/delete/action:<actionKey>).
- optional resources: array of independently typed Kernel resources. Only person_directory is supported, with list/get/create/update/delete operations.
- at least one valid Model or Kernel resource must be selected on creation and on saving a new configuration.

Person Directory is the Kernel-owned Space Person entity (per_*), not the ordinary person_profile Model.
Selecting it in the MCP Server catalog does not create a Data Grant or grant client access.
At actual MCP execution time, Adapters must intersect the configured tool allowlist with current Credential Scope, Application Model Access for ordinary Models, current Space/Person Directory Grant, Delegation and record Policy.
For linked Persons, the Core Person Directory still enforces owner/self/edit/delete limits.

## Core authority

Core owns current state in mcp_server_definitions: id, display_name, description, enabled, config_json, revision, attribution and timestamps.
GET/POST /api/v1/platform-admin/mcp-servers and GET/PATCH /api/v1/platform-admin/mcp-servers/{serverId} are the only control-plane routes.
POST creates and enables after validating current published Model operations; PATCH edits current configuration with expectedRevision, or separately changes enabled with exact confirmId + expectedRevision.
All operations require models:manage executor + short-lived human platform_admin_actor proof and are logged in platform_admin_audit.
The Console BFF additionally requires same-origin JSON, operation-specific intent and ID confirmation when enabling/disabling.

## Schema 78 data conversion

Schema 77 has already been deployed to Staging; its SQL history is immutable. Schema 78 is a new numbered migration.
For previously published Servers, convert the previously EFFECTIVE published manifest's selected operations, not a separately edited unpublished draft.
Previously draft/withdrawn Servers become disabled configurations, retaining their selections for correction and possible re-enable.
Preserve IDs, names, descriptions, creator/updater and timestamps. Drop the obsolete publication history table and its immutability triggers; keep platform_admin_audit.
Back up Staging D1 before this breaking control-plane migration. Production remains unchanged unless independently approved.

## Console workflow and acceptance

Create with Model/Person selections and at least one operation → enabled. Save edits directly after validation → latest configuration, internal revision increment.
Explicitly disable/enable with confirmation; don't erase capability selections. Detail → Back resets the stale create form.
Tests: model-only, Person-only and mixed configuration, invalid Model/Kernel selection, revision conflict, platform authority and audit, migration conversion, no publish/revisions endpoints, no new user-facing version.
The planned public MCP URL is not a live endpoint until a separate Adapter and OAuth integration is deployed.


## Runtime OAuth Agent Direct gate (separate dependent candidate; not deployed)

This gate is **not** the privileged MCP Server Console API and does not
expose Server configuration to an arbitrary OAuth client. It is the
Core-owned enforcement of the current enabled Server Tool Exposure Policy.

For an Identity-signed `purpose=oauth_agent_execution` read-only Agent JWT:

1. The exact OAuth Resource URI must be an HTTPS URL whose path is
   `/mcp/{mcp_*}` with a Core-generated 32-hex-character Server ID.
   The old unscoped `/mcp` resource is **not** a governed Server.
2. Core revalidates the OAuth Authorization/token/Agent binding through
   Identity on every authenticated call. It also loads that Server's current
   `enabled` flag and `config_json` from its own D1, never another app's D1.
3. Only models with the explicit `query` operation remain in the OAuth
   progressive Discovery inventory; the one selected Space constraint,
   current Agent Data Grant, Application × Model Access and published model
   access continue to narrow the result. External Models and Person Directory
   are not exposed by this first Native Query-only slice.
4. Each authenticated model semantic detail read and Canonical Query POST
   checks that the same Server is still enabled and that the Model still has
   its `query` operation. A stale Tool listing cannot bypass a changed
   Server configuration. Missing/invalid Server or configuration fails closed.
5. OAuth Scope is restricted to `resources:read` and the Actor/Principal
   remains the current Agent. User Delegation requires its independent
   explicit authorization process; `allowUserAuthorization` creates none.

This is an **incremental candidate behind LifeSpace #480** (Identity-owned
execution credential) and before [Issue #482](https://github.com/huangshirui/LifeSpace/issues/482)
can be closed. Remaining dependencies: Adapter RFC 9728 path-aware routing
for `/mcp/{serverId}`, Core-to-Adapter transport, exact Identity Resource
allowlist + private Resource Server secret, reviewed OAuth client registration
and full Staging acceptance. Current Core OAuth-specific D1 server-policy read
is deliberately isolated from ordinary Runtime principals; future performance
convergence may batch it with the existing current-Authority read.

No Account Center implementation and no production rollout are included.


## Public resource ingress and Identity verification (dependent candidate)

Core owns the single public origin `core[-staging].aisr.online`. The unprivileged `POST /mcp/{mcp_*}` and `GET /.well-known/oauth-protected-resource/mcp/{mcp_*}` routes first check the current `mcp_server_definitions.enabled` flag, then forward to one private `MCP_ADAPTER` Service Binding. They never bypass Identity OAuth or use a Platform Admin token. Unknown/disabled Servers return 404. Missing Adapter binding or a transport failure returns 503; no fallback to ordinary Core business APIs.

The private `POST /internal/v1/oauth/mcp-resource/validate` route authenticates the same-environment Identity caller with the existing Core↔Identity shared secret, and returns only whether the exact canonical Resource is currently enabled. Identity requires this before creating and confirming dynamic OAuth grants; Core separately enforces the selected Space/Agent/Model query policy during every operation.

The `MCP_ADAPTER` binding is intentionally **optional and not configured in canonical Wrangler environments yet**. The staging Adapter Worker must be separately deployed with no public routes and environment-matched CORE and IDENTITY bindings before the Core service binding is installed. No production change is implied by merging this candidate.


### Bounded batched semantics for MCP `tools/list`

The OAuth Agent Direct read-only discovery path first obtains the one-Space current inventory and then uses `POST /api/v1/spaces/{spaceId}/_discovery/models/batch` with up to **32 unique model keys**. This is an internal Core API, not a new generic public authority. Core rejects non-OAuth callers, other Spaces, duplicate/unknown/non-selected/external models, and any model without current read Data Grant. It rechecks the current enabled MCP Server and allowed query operations before returning any model metadata. A stale `tools/list` never grants a later `tools/call`, which is separately checked.

The batched design avoids a per-model Adapter→Core→Identity chain and stays below Cloudflare's 32 Worker-invocation-per-request service-binding limit. All-or-nothing authorization prevents partial responses that disclose unauthorized model semantics. Out-of-limit lists fail rather than silently truncating Server configuration.

For a **read-only protocol wire** probe after protected Staging deployment, set `LIFESPACE_STAGING_MCP_RESOURCE_URI` to the exact enabled `https://core-staging.aisr.online/mcp/{mcp_*}` URI and run `node infra/scripts/verify-staging-mcp-server-wire.mjs`. This checks Resource metadata and invalid token rejection only, **not** OAuth Consent, token exchange or Core data access. The historical isolated `/mcp` probe is not canonical Server acceptance.


## OAuth Agent enrollment without per-Space triples (candidate, #629)

Core MCP Server governance 0.12.0 adds an optional **`delegationAgents`** list of exact `{applicationId,agentId}` pairs, alongside the existing `delegationContexts` (Space/Application/Agent) list. This is the smallest stable, platform-owned configuration ceiling needed to admit a shared registered Agent for many consenting Users. Neither list grants model/Person access, User authority, Space membership or Delegation. Identity independently checks that the Agent is active and attached to the selected active Application.

When a User connects an OAuth MCP Client, Account uses the exact enabled `mcp_*` Server's configured list and the User's **current manageable Space membership** to project eligible choices. The User still selects **one** Space and explicitly opts into User Delegation; Identity binds the exact User, OAuth Client, Application, Agent, Resource, Space and approved scopes in `oaz_*`. Core's later `arq_*` request and `dlg_*` issuance require a separate real User confirmation, current OAuth authorization, exact operation/server selection and current User/model/Space authority. A revoked Server enrollment blocks new zero-Grant OAuth consent; it does not itself revoke an already issued delegation, whose own current authority and revocation still govern execution.

Existing exact `delegationContexts` remain accepted for backward compatibility and for the **trusted opaque-Agent MCP** profile. A `delegationAgents` pair alone never admits `lsp_agt_*` to a Space; the existing exact trusted-MCP context remains required. This intentionally does not alter n8n trusted workflow confirmation or make raw Agent credentials self-approving.

The Console editor shows Application → Agent only for new OAuth enrollment and retains legacy per-Space settings for display/removal. No Core/Identity storage migration is necessary: this is an additive validated Server configuration property, not a new authorization table. Tests must cover two Users, multiple Spaces, no direct Data Grant, viewer/nonmember denial, malformed/duplicate pair, revoked Server policy, wrong Agent/Application, trusted-credential non-expansion, and legacy compatibility. Candidate only until exact-head CI and staging verification; no production claim.

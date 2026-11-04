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

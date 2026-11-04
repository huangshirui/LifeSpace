# LifeSpace MCP Domain Server Definition & Publication

Status: **V7 Staging implementation candidate**, not a claim that public MCP transport is active.

## 中文摘要

LifeSpace Console 的「MCP Servers」负责管理一个平台公共领域 Server 的**稳定标识、模型与操作集合及发布历史**。MCP Server 不是 Application、Space、Service/Agent、OAuth Client 或通用 Connection。一个 MCP Server 定义可列出多个已发布模型与每个模型的多个操作，不携带用户数据权限。发布只让 **Core 控制面目录版本**生效，**不会自动创建 URL 路由、部署 MCP Adapter 或分配 OAuth 权限**。

## Authority / 归属

- Core is the canonical owner of the platform control-plane catalog, drafts, publication history and human/executor audit. No business record or Space ownership is transferred.
- Console owns only a presentation and bounded same-origin BFF. All mutations require a verified Platform Admin actor proof and an operation-scoped Console Core service executor with existing `models:manage`; no bootstrap secret or ordinary Space credentials.
- MCP Adapters will later consume an approved published catalog through a separate authenticated integration. They must reconcile it with *current* Core Runtime Discovery and re-authorize every execution. Published manifests do not override existing Application × Model Access, Credential Scope, Data Grant, Delegation or Model Policy.
- Identity OAuth and third-party client/user consent are deliberately out of scope. The V6 `unified_connections` and `conn_*` proposals are not dependencies.

## Domain Server definition / 定义

- Stable `key`: lowercase slug, 2–40 characters; the planned Resource Server path is `/mcp/{key}`. Keys cannot be changed.
- `name`, optional `description` and `draft.models[]`.
- Model entry: unique published `modelKey`, explicit unique `operations[]` in `get/query/create/update/delete/action:<actionKey>` form.
- Drafts may be initially empty. Publishing requires at least one model and validates every operation against the current published Model Definition: reads require `read`, mutations require `write`, and declared actions must exist with an exposed `read`/`write` requirement.
- The publication manifest pins each model's current `version` and `schemaHash` alongside the selected operations. It is hashed with SHA-256; the frozen revision table is protected from UPDATE/DELETE by D1 triggers.
- A published Server can have an edited draft while the prior revision stays active. Publishing the changed draft increments `publishedRevision`. Withdrawal stops being active in the management catalog but does not destroy the immutable revision history; later republishing increments the version.

## UX / Console

1. Open Platform → MCP Servers, view status, planned `/mcp/...` path and published version.
2. Create a Server draft using name and stable key.
3. Add one or more currently published Models; choose one or more declared operations per Model. Save the draft. Stale edits reject with `VERSION_CONFLICT`.
4. Publish with exact key confirmation; Core validates live Registry semantics and pins a version.
5. Review immutable history; withdraw with explicit confirmation when needed.

UI communicates that these are **catalog releases**, not deployed public MCP endpoints.

## Contract / API

Privileged Core Platform Admin API `0.6.0`:

- `GET/POST /api/v1/platform-admin/mcp-servers`
- `GET/PATCH /api/v1/platform-admin/mcp-servers/{serverKey}`
- `POST /api/v1/platform-admin/mcp-servers/{serverKey}/publish`
- `POST /api/v1/platform-admin/mcp-servers/{serverKey}/withdraw`
- `GET /api/v1/platform-admin/mcp-servers/{serverKey}/revisions`

All calls require the paired service executor + short-lived human proof and use canonical Core D1 state. Console BFF exposes only matching bounded `/api/mcp-servers*` endpoints protected by exact Origin/Fetch Metadata/JSON/intent guards and action-specific request shape.

## Rollout, tests, rollback

Migration `0077_mcp_server_registry.sql` is additive and replaces no existing Authority tables. Apply through the normal **Core Staging migration + Worker** pipeline before deploying the Console staging UI. **Do not run the Console-only deploy to introduce the new API**: that flow intentionally does not deploy/migrate Core. Use the existing platform Staging workflow with its release-candidate checks, then the isolated Console Staging deploy. Production is not in scope.

Tests cover admin actor/executor denial, malformed/duplicate draft inputs, model/action validation, optimistic revisions, stable publication snapshots, withdrawal, immutable SQL history and audit. Before declaring staging Ready, run live Console browser creation/edit/publish/withdraw and verify the Core catalog remains consistent.

## Next integration boundary

A separate `lifespace-adapters` implementation consumes published definitions. The Adapter must reject stale manifest model hashes, unknown operations, unpublished Server status, and callers without current Core authorization. Until that is tested and deployed, the planned Server URL is not a live endpoint.

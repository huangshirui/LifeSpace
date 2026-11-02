# Unified Connection — target contract v1 / 统一连接目标契约

> **Status: restricted draft management API candidate on a Draft branch; not merged or deployed.** This document is not a Production capability claim. It captures user-approved invariants for the upcoming LifeSpace Core implementation. Open questions below must be resolved through Staging evidence before authorizing changes to OAuth/Identity runtime semantics.

## Goal / 目标

A Connection is a governed **application access configuration**, not a replacement for LifeSpace identities, Data Grants, Delegations, Webhook Eventing or Provider Adapters. LifeSpace Core is the sole authoritative store for Connection metadata. `account.aisr.online` is a management experience/BFF, **without its own Connection database**.

Connection is a platform concept even when the requesting UI is ALOHA, HomeMew or another application. Neither an MCP server nor a REST endpoint owns Connection data.

## User-approved invariants / 已确认规则

1. **Four kinds**: `agent`, `service`, `event_push`, `external_data`. MCP/REST are transports, not Connection kinds; OAuth/API Token are authentication methods, not kinds.
2. **Immutable bindings**: one `applicationId`, one `spaceId`, one `kind` per Connection. `name` and optional `note` can be edited. `owner` is an independent management relation; cross-boundary transfer is not ordinary PATCH behavior.
3. **Dedicated identity**: a Service Connection exclusively owns one `svc_*`; an Agent Connection exclusively owns one `agt_*`. That identity cannot be reused by another Connection. Each identity may hold multiple independently revocable credentials. Identity stores credential material/hashes; Core stores non-secret identity references only.
4. **Existing authority semantics unchanged**: Agent Direct = Principal Agent / Actor Agent with its current Data Grant; represented User/Agent requires explicit current Delegation. Service Direct = Principal Service / Actor Service. Application Model Access, Credential Scope, Space Authority, Delegation and Policy still intersect in Core. No hard-coded read-only Agent Direct rule.
5. **Event Push**: one visible Event Push Connection can internally manage the subscriber `svc_*` required by the current Webhook Endpoint contract. Users should not need to create a second visible Service Connection just to receive signed events. A downstream workflow reading the referenced record still needs its own effective read authority.
6. **External Data**: a visible Connection may refer to an existing Core External Provider connection `cnx_*`; Provider Adapter owns private credential vault. Do not confuse `conn_*` (cross-type management) with `cnx_*` (External data-provider resource).
7. **MCP is shared**: a domain MCP Server is one reusable protocol service for many Connections. The proposed route `/mcp/{domain}/{connId}` selects a Connection as a **nonsecret locator**. It must not authenticate the caller or grant permission merely because its ID appears in the path. A Connection can be addressed through more than one published domain endpoint.
8. **OAuth**: Cloudflare Managed OAuth is the selected provider; callback allowlists are configured through LifeSpace Console. We must validate token resource binding and safe Connection/Agent attribution on Staging; the OAuth configuration of today's experimental MCP Worker is not a final architectural constraint.
9. **Create flow**: an application launches a trusted Account-hosted creation flow; ordinary browser-supplied `applicationId`, `spaceId`, `agentId`, `userId` or `connectionId` is never identity/management authorization proof.
10. **Cutover**: only HomeMew's actually used Service and Agent Direct connections will be rebuilt. After verifying newly created credentials in n8n, switch over and revoke old credentials. No compatibility layer or migration for unused OAuth/Delegation/External Data configurations.

## Minimal public metadata shape / 最小元数据

The draft JSON Schema is maintained at `apps/core/unified-connection.contract.json`. It deliberately models **nonsecret read metadata only**, not create/update payloads, credential issuance or business record storage.

```json
{
  "connectionId": "conn_example",
  "applicationId": "app_example",
  "spaceId": "spc_example",
  "kind": "agent",
  "name": "Household n8n Agent",
  "note": "Optional user note",
  "status": "active",
  "owner": { "type": "space", "id": "spc_example" },
  "identity": { "type": "agent", "id": "agt_example" }
}
```

Only `agent` and `service` kinds carry an externally visible dedicated identity reference. Event Push subscriber identities and External provider credentials are backend-owned dependencies, not extra user-created Agent/Service Connections.

## Lifecycle contract / 生命周期与安全边界

- A Connection is not `active` until its required backing identity and scoped resources are ready.
- Core/Identity operate on their own databases, never on each other's D1 tables. Creation across services requires explicit failure compensation/idempotency; no fake cross-service transaction.
- Disabling or revoking a Connection must prevent **new execution** on that Connection. All of its dedicated Agent/Service credentials must stop working for that Connection after revocation; issuance and invalidation require an authenticated, authorized server-side path.
- Credential scopes and actual current Core Data Grants are not duplicated into a second permission store. Configuration UI is not an authorization boundary.
- Underlying identities and Webhook/Eventing/External resources retain their own canonical contracts and audit rules.

## Open implementation gates / 不得擅自定案

1. **Cloudflare Staging POC**: verify that OAuth authorization and refresh respect `/mcp/{domain}/{connId}` as a protected resource and cannot replay one Connection token against another. Verify which trustworthy client/grant attributes the Worker receives, without logging tokens/user data. Do not infer `agt_*` brand from unauthenticated `client_name`.
2. **Cross-Application Account administration**: specify exact trusted creation launch ticket, management rights and Core↔Identity credential/identity orchestration API. An Account page must not wield Console Platform Admin powers as a shortcut for ordinary user management.
3. **Identity lifecycle**: one-to-one Agent/Service identity creation and revocation, multiple credentials, and Event Push internal subscriber dependency; specify fail-closed states and retries without adding a new authorization system.
4. **Ownership**: clarify the manager transfer UX/authority rules before exposing mutable `owner`.
5. **Cloudflare configuration**: confirm callback allowlist writes/reads at the correct Access Application and environment; Console UI is an operator surface, not a new OAuth authority.

## Implementation order / 实施顺序

1. Freeze and verify the nonsecret metadata contract and test invariants (this slice).
2. Staging OAuth resource/client information POC without changing Production.
3. Implement Core Connection registry/lifecycle and secure Identity integration; add positive, revoked and cross-connection denial tests.
4. Integrate four kinds, Account and Console management, domain MCP adapter, n8n Trigger improvements.
5. Validate all four kinds on Staging, then switch only currently used HomeMew n8n credentials.

No legacy `ext_*` or production Webhook endpoint is deleted as part of this document-only slice.

The full Connection lifecycle is **not implemented or deployed**. The candidate only permits safe, current-Application-scoped metadata reads and **unprovisioned pending drafts**. No Identity credential or provider resource has yet been created.

## Current app-scoped draft management slice / 当前仅限应用内草稿管理

On a Draft branch only, the endpoints are:

- `GET /api/v1/spaces/{spaceId}/connections?limit=20&offset=0` — current-Application visible list.
- `GET /api/v1/spaces/{spaceId}/connections/{connectionId}` — current-Application visible detail.
- `POST /api/v1/spaces/{spaceId}/connections` — create a `pending`, non-executable draft. Only `kind`, `name`, optional `note`, and `ownerType` (`space` or `user`) are accepted. Application and Space come from the verified request context. Owner `user` always means the signed-in user.
- `PATCH /api/v1/spaces/{spaceId}/connections/{connectionId}` — update display `name`/`note` only, using required `expectedUpdatedAt` to reject stale updates. Cannot change execution authority.
- `DELETE /api/v1/spaces/{spaceId}/connections/{connectionId}` — mark an **unprovisioned pending** draft revoked; refuses drafts whose identity or backing resource has been provisioned. This operation is not live credential revocation.

All routes require an authenticated User, `spaces:manage` and **current** Space `manage` authority. The Application is fixed by authenticated `principal.clientId`, never a client-provided Application selector. Space-owned drafts are managed by current Space managers; a user-owned draft is visible only to its owner subject to the same Space authority. Unknown or foreign Connection IDs return 404 without leaking details.

Creating a draft does **not** issue `agt_*` / `svc_*`, create Grant/Delegation, configure Webhook or External Provider credentials, generate MCP URLs, bind OAuth clients, or activate tools. An Account cross-Application management surface, trusted creation ticket, Identity-side lifecycle/compensation, active revocation and Cloudflare OAuth token binding remain separate implementation gates. Existing `cnx_*` External connections are untouched.

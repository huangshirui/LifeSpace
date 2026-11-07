# OAuth MCP Staging integration checklist / OAuth MCP Staging 联调验收

Status: **staging candidate only / 仅为 Staging 候选**. This document does not claim full OAuth/MCP execution has been released.

## Ownership and parallel work / 模块边界

| Candidate | Responsibility / 职责 | Release dependency |
| --- | --- | --- |
| LifeSpace [#480](https://github.com/huangshirui/LifeSpace/pull/480) | Identity's OAuth → short-lived Agent Direct execution, Core rechecks live authority | Deploy platform Staging after reviewed merge |
| Adapters [#29](https://github.com/huangshirui/lifespace-adapters/pull/29) | OAuth MCP Protected Resource and current Core query tools | Deploy separately after verified Identity/Core |
| LifeSpace Account Center [#479](https://github.com/huangshirui/LifeSpace/pull/479) | Account overview and read-only user/Space UI; preserves OAuth Consent | Can develop/release independently |
| LifeSpace [#481](https://github.com/huangshirui/LifeSpace/issues/481) | Future Account user-scoped authorization list/revoke | Not required to test initial Consent |

Identity D1 owns OAuth registrations, grants, codes, tokens; Core D1 owns Space/Grant/Delegation and MCP Server configuration. Account is experience/BFF only, **no Account D1**. The Adapter never receives direct DB credentials or broad Service Admin authority.

## Two distinct MCP endpoints / 两种路径不要混淆

The planned production domain-server URL is `https://core.aisr.online/mcp/{serverId}` (Core-generated `mcp_*` ID), per `docs/mcp-server-governance.md`. Core MCP Server definitions are configuration, **not an active protocol route**. The current OAuth Resource candidate in Adapters #29 understands only **`/mcp`**.

Before full product E2E, resolve [#483](https://github.com/huangshirui/LifeSpace/issues/483): either implement the canonical per-server routing and Server-config/capability restriction, or use a **separately labeled, temporary single-resource Staging protocol probe** at an isolated `*-staging.aisr.online/mcp` URL. A passing Staging probe is **not proof** that the agreed production per-server URLs work.

## Safe read-only preflight / 无授权数据的协议探针

After a reviewed isolated Staging Resource Server is actually deployed:

```bash
LIFESPACE_STAGING_MCP_RESOURCE_URI=https://example-mcp-staging.aisr.online/mcp \
  node infra/scripts/verify-staging-oauth-mcp-wire.mjs
```

The example hostname is illustrative; it must be replaced by the *exact* operator-approved Staging Resource URI. The script accepts only an isolated `*-staging.aisr.online/mcp` origin. It checks:
- Identity's exact Staging OAuth metadata, endpoints and S256 advertisement.
- RFC 9728 Protected Resource metadata: exact resource and Identity issuer.
- `POST /mcp` without a bearer returns the correct Resource-specific 401 challenge.
- A synthetic, never-issued bearer is rejected with 401.

It **does not** log, require or read real OAuth tokens, account cookies, client credentials or user data. It registers no client, issues no grant, and never calls Core business APIs. A passing result proves only the **public protocol boundary**. Do not use it as an E2E badge.

## Actual OAuth / MCP E2E acceptance (future)

1. **Deploy** the exact reviewed LifeSpace Core/Identity candidate to Staging using the existing owner-only `Deploy LifeSpace platform staging`. Re-run Account staging only when its UI/config changes require it.
2. Configure exact single Staging OAuth Resource URI and private `OAUTH_RESOURCE_SERVER_SECRET` in matching Identity/Adapter Workers, isolated from Production; preserve bound `IDENTITY` and `CORE` Service Bindings. Avoid the retired Managed OAuth Preview.
3. Register a **reviewed test OAuth Client** with strict redirect URIs, using an approved guarded flow; DCR must not become an open registration endpoint without explicit protections. Do not fabricate an existing Client ID.
4. Authenticate real User via Access in Account → choose Application/Space/Agent and execution mode → explicit Consent → PKCE S256 callback → token exchange.
5. Test MCP initialize, current `tools/list` and `tools/call` against Core, each under current Agent Direct/read-only authority. Verify wrong Resource/Client/Space, revoked access token, removed Agent Grant, disabled Application/Agent, invalid signer and absence of implicit User Delegation.
6. Record precise Staging deployed SHA and negative-test evidence before considering production rollout. Account's future full self-service management can proceed in parallel.

## Operator stop conditions / 停止条件

No Production release or user-data claim if the canonical Resource URI is unsettled, the Adapter endpoint is not deployed, OAuth Client registration/redirect policy is unsafe, execution token can escape selected Space, or the Resource Server forwards opaque public OAuth bearer directly to Core. Never auto-dispatch canonical Staging or Production workflows. 

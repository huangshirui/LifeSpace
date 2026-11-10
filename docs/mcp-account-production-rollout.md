# MCP + Account Center Production Release Runbook / 首次生产发布操作指引

> **Status: PRE-RELEASE (not deployed) / 未上线。** This is an operator-reviewed rollout plan, **not** a description of currently deployed Production capabilities. The authoritative production truth remains in `docs/production/` and changes only after successful exact-SHA deployment.
>
> Release tracking: [LifeSpace #499](https://github.com/huangshirui/LifeSpace/issues/499), [Account #514](https://github.com/huangshirui/LifeSpace/issues/514), [Production #511](https://github.com/huangshirui/LifeSpace/issues/511), [Adapters #50](https://github.com/huangshirui/lifespace-adapters/issues/50).

## 1. Agreed release scope / 本期范围

Ship independently deployable, Identity-owned **OAuth2 + exact Core `mcp_*` Resource + private MCP Adapter + Account Center**. Keep Core as the authoritative identity/Space/Grant/Model/Delegation/Change owner. The Agent can request but never grant a User Delegation; Account is the independently authenticated approval surface.

- **Already accepted on Staging**: Native governed Agent Direct CRUD/query; Person read and narrow User Delegation; Notion External query/create/update via Account-approved Delegation; one-use replay denial, timed reuse/revoke; OAuth Client and Model/Space revocation controls; Account OAuth authorization list and individual revoke; static Resource metadata and no-token Bearer challenge.
- **Owner explicitly waived** External Delete testing. URL-mode MRTR auto-resume in a particular client, MCP Apps/Tasks/Subscriptions, and non-essential cross-consumer unification are not blockers.
- **Post-Production enhancement** (deferred by Owner): full Space overview/member/invite/settings tabs, cross-application User Delegation management, External Connection create/edit/disable/revoke UX, full user-visible Delegation/Space audit. New Account profile/email/avatar, invitation, logout and mobile interactions may be validated during actual Production usage; do not claim these browser flows were already exhaustively accepted.

These scope exceptions do **not** waive effective permission enforcement, OAuth Scope/PKCE, cross-Space/Resource isolation, CSRF, audit attribution on Core changes, or rollback requirements.

## 2. Freeze and verify release candidates / 锁定与验证候选

1. Select a reviewed LifeSpace `main` SHA and separate public `lifespace-adapters` `main` SHA. Require their relevant **exact-head main CI success**, including tests, security/secret scanning, contract checks and dry-run builds. A green PR head alone is insufficient.
2. Require Owner manual **LifeSpace Platform Staging**, **Account Staging** and **private MCP Adapter Staging** releases on the intended candidate SHAs, with no non-reviewed commits between the exact candidate and release. Routine Account deploy must not rotate secrets; explicit provisioning/rotation has its own protected workflow.
3. Run a **separate OAuth-enabled, raw Streamable HTTP MCP client** against an enabled, disposable Staging `mcp_*` Resource. The ChatGPT connected Tool UI alone does not prove raw `resources/list/read`.

### Minimal MCP Inspector check / 独立协议客户端

Use Node 22.19+ and the current official MCP Inspector from a trusted local workstation, never from a public CI runner with user credentials:

```sh
npx @modelcontextprotocol/inspector@latest --server-url "https://core-staging.aisr.online/mcp/mcp_<staging-server-id>" --transport http
```

Use the Inspector's supported browser OAuth + PKCE flow. Explicitly review Client/Space/Agent/Resource/Scope in Account Consent. In the Inspector, run `tools/list`, `resources/list`, then `resources/read` using an actual URI from the **current listed resources**, such as `lifespace://spaces/{spaceId}/models/{modelKey}`. Inspect that the model descriptor and `structuredContent` are permitted and no other Space leaks. Test both supported protocol eras if the client allows it.

A **second dedicated read-only OAuth authorization** should confirm that writes get `403 insufficient_scope` and never mutate; a separately authorized other `mcp_*` Resource must reject cross-Resource token reuse, invalid Resource URI and revoked/disabled access. Confirm old Access/Refresh tokens reject after revocation. Never use or rotate an existing user's active ChatGPT production connection for a negative test.

**Security**: OAuth bearer/refresh, cookies and Account sessions must never enter terminal command arguments, GitHub Issues, public CI logs, screenshots, source trees or this runbook. Inspector may store sensitive tokens locally; prefer a supported OS keychain and remove dedicated test credentials after acceptance. If this positive live test cannot be run, record it as **NOT VERIFIED**, not PASS.

## 3. Production infrastructure prerequisites / 不满足则不发布

Before the first production mutation, use **read-only** Cloudflare/Identity inspection to confirm:

| Component | Required state |
| --- | --- |
| Private MCP Adapter | Independent Production Worker created from **exact accepted Staging Adapter SHA**, `workers_dev=false`, preview/public routes disabled, same-environment Core/Identity Service Bindings. Adapter owner-only `deploy-mcp-production-private.yml` prepares transport only; it does **not** activate public routing. |
| Core | Production `MCP_ADAPTER` Service Binding targets that **existing** private Worker; exact `mcp_*` server enabled/published only by authorized control-plane action. |
| Identity | Production `CORE` binding, exact issuer `https://auth.aisr.online`, Consent URL pointing to protected Account Production, Account application/audience, paired OAuth Resource Server secret. CIMD/DCR use reviewed **Production policy** (default off), explicit callback constraints and rate limiter. |
| Account | Independent `lifespace-account` Worker and `account.aisr.online` **Cloudflare Access protection before public Worker activation**, verified Account application audience and server-only `lsa_*` credential, CSRF secret, `IDENTITY`/`CORE` same-environment bindings. No Account D1. |
| Secrets | Independent Production values only. A paired `OAUTH_RESOURCE_SERVER_SECRET` on Adapter+Identity; paired `OAUTH_CORE_APPROVER_SECRET` on Core+Identity; Account-only `IDENTITY_APPLICATION_CREDENTIAL` and `ACCOUNT_CSRF_SECRET`; `OAUTH_ACCOUNT_APPLICATION_ID`, `OAUTH_ISSUER`, `OAUTH_CONSENT_URL` configured where required. Verify names and intended installation boundaries, **never reveal plaintext**. |

**Current gap (2026-11-10):** Production Account/Adapter Workers, Account Access/audience/credentials, and paired OAuth secrets/runtime bindings were not deployed in the observed environment. Code in `wrangler.jsonc` is **configuration intent**, not actual Cloudflare deployment evidence. Production remains **blocked** until the owner-reviewed provisioning procedures are completed.

**Order matters**: prepare Access policy and registered Identity Account application; owner-approve the exact accepted private Adapter Production transport; provision independent Production secrets/credentials through a protected store; deploy Core/Identity with their reviewed same-environment bindings using **the canonical Owner-only Production workflow**; deploy protected Account with its credentials and verify callbacks/CSRF; only then enable a disposable Production MCP Server for acceptance. Resolve any required Core/Identity pairwise deploy/order dependency before mutation. Do not copy Staging secrets, disable Access to bootstrap, or use Platform Admin tokens in Account.

No workflow in this repository may dispatch the canonical production workflow on the owner's behalf. Only the Owner executes `.github/workflows/production-deploy.yml` with `DEPLOY_PRODUCTION` after signing off on reviewed candidate and APAC performance gate. Adapter private preparation has its own explicit confirmations. **A final dedicated Account production provisioning process remains required**; do not treat an unreviewed manual `wrangler deploy` as a complete security procedure.

## 4. Production smoke, rollback, closeout / 正式验收与回滚

- Verify Worker versions, separate Staging/Production D1/R2/Queue/Service Bindings, Access application audience, issuer/protected-resource metadata, OAuth PKCE, DCR/CIMD policy, user session and Origin/CSRF protection. Do not claim workers.dev/private Adapter direct access.
- With an explicitly authorized disposable Production User/Space/Agent/Client: Consent → limited Query and optional write → Account one-use/timed Delegation → current-state revoke/denial; check exact `Principal=User, Actor=Agent` and Change attribution. Do not touch unrelated customer or real household data.
- Verify old Access/Refresh token rejection and cross-Resource/Scope/Space boundaries. Confirm denied actions do not mutate.
- Prepare rollback of individual Adapter, Account, Core and Identity **Worker code versions** plus D1 migration compatibility. Routine rollback must **preserve current secrets**; rotating or revoking shared secrets is an explicitly separate coordinated security operation.
- **After** the exact successful Production workflow and live verification, update `docs/production/capability-guide.md`, `feature-matrix.md`, `changelog.md` with SHA, date, actual capabilities, exclusions and observed limits. Append deployment/architecture decisions to LifeSpace Notion `99 · 架构演进与决策日志`.

## 5. Gate summary / 发布否决条件

Do not start Production if there is a failed main CI, unmatched Adapter Staging SHA, unverified OAuth Resource positive/negative protocol acceptance, unprotected Account domain, absent Production Worker/Secret/Binding, unresolved migration downgrade, or no owner-approved rollback route. The Owner-deferred Account enhancements and non-critical visual usage checks are **not** among these hard gates.

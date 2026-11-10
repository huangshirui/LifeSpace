# Account OAuth Staging rollout / Account OAuth 预发布验收

> Account Center was introduced in #515, with pre-deploy verification #516 and revocation UX #517; the new self-service redesign is a separate reviewed candidate. **A merged source or green CI does not establish Staging acceptance.** Only reviewed owner-triggered workflows on `main` may deploy. Never deploy a draft branch.

## Fixed topology / 已确定环境

| Environment | Account Worker | Access hostname | Persistent data |
| --- | --- | --- | --- |
| Staging | `lifespace-account-staging` | `account-staging.aisr.online` | **No Account D1** |
| Production | `lifespace-account` | `account.aisr.online` | **No Account D1** |

Both Workers independently bind their own environment's `IDENTITY` and `CORE` services. Identity D1 owns OAuth Clients/Authorizations/Tokens; Core D1 owns Spaces, Grants and Delegations. No Account database and no cross-application D1 binding.

### Owner-triggered Staging deployment / 独立发布与维护入口

**普通 Account 页面/逻辑修改，只运行 [Deploy LifeSpace Account staging](../../.github/workflows/lifespace-account-staging-deploy.yml)**，不需要先重复运行 Platform Staging。部署工作流仅：

1. 强制仓库 Owner 手工 `workflow_dispatch`、`main`、通过完整仓库 CI 与受保护的 `staging` 环境门禁；
2. 只读检查 Core/Identity 已部署版本是否与当前发布契约和 Schema 匹配；检查 Account Cloudflare Access 独立域名、Owner-only Policy；通过 Cloudflare API 只读检查 Account/Core/Identity 所需 Secret **绑定名称**；
3. **只部署** `lifespace-account-staging` Worker 代码与静态资源；Wrangler 会保留已存在的 Worker Secrets，不重新签发 `lsa_*`、不改 Cloudflare Access Policy、不修改 OAuth Shared Secrets，不运行 Core/Identity 迁移或发布；
4. 部署后只读复核 Secret 绑定名称。任何前置配置缺失应立即失败，不允许在普通发布中自动补配置或偷偷升级权限。

**仅首次初始化、明确的 Scope/Access 配置变更或经人工决定的密钥轮换**，才运行独立的 [Provision / rotate LifeSpace Account staging](../../.github/workflows/lifespace-account-staging-provision.yml)。该维护流程必须由 Owner 手动选择 `main` 并输入精确确认值 `PROVISION_OR_ROTATE_ACCOUNT_STAGING`，与普通/平台部署共用同一个并发锁。它包含原先的 Cloudflare Access Application 建立/核验、Identity Account Application/Audience 注册/受控 Scope 升级、单独 `lsa_*` 凭据签发与先验证后撤旧，以及必要时对 Core/Identity Staging 写入 OAuth 相关 Secret 的操作。**`wrangler secret put` 会立即创建/部署 Worker 新版本**，因此维护流程会影响 Core/Identity 的 Worker 部署及现有 OAuth 批准/CSRF 会话；只能作为明确的特殊操作，不可由普通发布自动调用。

首次采用本拆分流程时，若 Staging 的 Account Application 仍是旧三 Scope，必须先由 Owner 执行一次维护流程将其迁移到已审定的五 Scope，否则当前 Account BFF 申请 `profile:write`、`spaces:write` 的 User Token 可能失败。**平台代码或契约发生实际变更**时，才先单独运行 [Deploy LifeSpace platform staging](../../.github/workflows/staging-deploy.yml) 使 Core/Identity 达到兼容版本。

密钥明文仅在受保护的维护工作流运行中使用；普通 Account 发布不再需要 `LIFESPACE_STAGING_BOOTSTRAP_SECRET`。两条工作流均不自动运行、不使用 Production、无 Account D1。

## 0. Dependencies / 前置条件

- Merge pre-deploy correctness review #516 with passing exact-head CI; #469 is historical and merged. No Staging claim follows from CI alone.
- 在真正的 Core/Identity 平台代码或 Schema/契约变化、且当前 Staging 尚未兼容时，由 Owner 先手工执行 `staging-deploy.yml`；普通 Account 修改不重复部署 Core/Identity。发布 SHA 的 Core/Identity 契约版本与 Schema 必须符合 `infra/scripts/staging-expectations.mjs`。
- Confirm `auth-staging.aisr.online/api/v1/status` and `core-staging.aisr.online/api/v1/status` report staging and exact expected schema/contract versions. Do not skip the existing staging golden-flow verification.
- The public Account Web domain is `account-staging.aisr.online`. It is **not** the platform-admin Console (`lifespace-staging.aisr.online`).

## 1. Cloudflare Access / 登录边界

- Create one self-hosted Access application whose *only* protected hostname is `account-staging.aisr.online`. Initially use a strict **Only Me** explicit user-email allow policy, using the same validated owner identity policy as existing LifeSpace Console Staging. No Everyone, domain allow-list, broad group, or service-token inclusion. Review deny, session TTL and ingress behavior.
- Confirm Access policy protects both `/oauth/consent` and all `/api/*` paths. In particular, requests with forged `Cf-Access-Jwt-Assertion` must not bypass Access/Identity validation.
- Record the independently issued Account Access `aud`. Do **not** reuse Console or MCP Preview Audience. Identity associates each Audience to exactly one LifeSpace Application.

## 2. Account LifeSpace Application / Identity 身份源

- Via the approved Identity bootstrap/provisioning workflow (not browser JavaScript), ensure a dedicated active trusted Application `app_lifespace_account_staging` with **exactly** `profile:read`, `profile:write`, `spaces:read`, `spaces:write`, `spaces:manage`, and 900-second JWT TTL. Existing exact legacy three-scope Staging Account application may be upgraded via the reviewed owner-triggered provisioning step only; any other policy drift fails closed. No platform-admin, grant modification, or service-automation scopes.
- Register the Account Access Audience in Identity **only** against that Account Application, and verify it is active and unique.
- Issue the Account `lsa_*` credential using the existing one-time secret provision mechanism. Inject it only as Account Staging Worker secret `IDENTITY_APPLICATION_CREDENTIAL`; never write plaintext into the repository, workflow logs, browser or Notion.
- Set `OAUTH_ACCOUNT_APPLICATION_ID=app_lifespace_account_staging` on **both** Core and Identity Staging (exact match). Do not change existing Console Application mapping.

## 3. Dedicated trust and OAuth settings / 凭据隔离

以下是**显式 Provision/Rotate 工作流**的初始化/轮换要求，普通 Account 发布绝不执行这些 Secret 操作。

- Generate a new independent random `OAUTH_CORE_APPROVER_SECRET` (at least 32 unpredictable bytes) and install the **same secret** on Core and Identity Staging only. It must not equal `CORE_IDENTITY_SHARED_SECRET`, `OAUTH_RESOURCE_SERVER_SECRET` or an Account credential.
- Generate a separate random `ACCOUNT_CSRF_SECRET` (32+ random bytes) for Account Staging only.
- Set fixed Identity `OAUTH_ISSUER=https://auth-staging.aisr.online`, `OAUTH_CONSENT_URL=https://account-staging.aisr.online/oauth/consent`. Never derive the issuer from an untrusted Host header.
- Bind Account Worker `IDENTITY` to `lifespace-identity-staging`, `CORE` to `lifespace-core-staging`; verify no production bindings.
- Leave `OAUTH_ALLOWED_RESOURCES` unset and DCR disabled until the **canonical staging MCP Resource URL** and a matching protected Resource Server are deployed. Fail-closed is preferable to guessing public URLs. When ready, allowlist *only exact canonical staging Resource identifiers*.
- Provision a separate `OAUTH_RESOURCE_SERVER_SECRET` only into the intended staging Resource Server and Identity, not into the browser or Account. Never pass OAuth bearer credentials directly to Core.

## 4. Verification gates / 验收清单

1. Run `pnpm --filter @lifespace/account check` and full repository CI for the exact staged SHA.
2. 对普通 Account 发布，运行 `node apps/account/scripts/verify-staging-access.mjs` 和 `node apps/account/scripts/verify-staging-bindings.mjs` 作只读预检。原 `check-staging-readiness.mjs` 是 OAuth 端到端私有配置盘点，会故意把无法独立读取的私有注册/Secret 标为待核，**不要**以这个盘点报错作为普通代码部署的自动配置理由。
3. As Account owner, login via Access; assert raw Access JWT does not appear in browser responses or logs. Verify non-Account issuer/app JWT, removed Space manager membership, revoked Agent Grant and revoked Agent/Application bindings all fail confirmation.
4. Verify no valid prior `request_id`, duplicate Code, wrong client redirect, PKCE downgrade, wrong Resource or revoked authorization can be replayed or exchanged.
5. Verify Application → Space → Agent → execution mode, the **pre-policy Native model upper-bound** (read/write limited by currently requested OAuth Scope), mobile UI and explicit consent click. If model preview cannot load, approval is disabled.
6. Verify Access owner-only policy, cookie `__Host` flags, no-referrer/CSP and Same-Origin CSRF on the actual deployed HTTPS hostname.
7. Run a real OAuth callback only against a reviewed, separately authenticated staging MCP Resource Server. Test distinct Client/Audience/Agent/Space isolations before declaring genuine interoperability.

## Stop conditions / 停止条件

No end-user OAuth deployment or production rollout if any of these fail: Account SSO not bound to registered Access Audience; any secret missing; callback origin not exact; current Core authority failing; effective tool operation permission absent; DCR unsafe/unbounded; token revocation not current-state; Core receives the public OAuth bearer instead of a trusted execution token; separate staging MCP Adapter not built.

### Current read-only inventory (2026-11-05)

The account-specific Access application and account Worker were **not present** in the connected Cloudflare account when checked. Existing Identity/Core Staging Workers were present but their publicly listed secret binding names did not include `OAUTH_CORE_APPROVER_SECRET` or `OAUTH_ACCOUNT_APPLICATION_ID`. This is only an inventory observation, not credential access, and must be rechecked at deployment.

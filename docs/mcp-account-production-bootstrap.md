# MCP + Account 首次 Production 安全初始化 / Operator checklist

**状态：准备稿；尚未执行 Production 部署。** 该指南描述严格的发布顺序和 Owner-only GitHub Actions 入口。旧版 Production 能力文档仍是已部署事实，不因本文件而升级。

## A. Protected Environment inputs / 先配置受保护环境

**LifeSpace Repository / Environment `production`**:
- Existing `CLOUDFLARE_API_TOKEN` and account ID; `LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET` (for first-use Identity Application setup)
- `LIFESPACE_PRODUCTION_ACCOUNT_CSRF_SECRET` — distinct stable secret, >=32 random bytes
- `LIFESPACE_PRODUCTION_OAUTH_CORE_APPROVER_SECRET` — distinct stable secret shared by Core and Identity
- `LIFESPACE_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET` — distinct stable secret shared by Identity and MCP Adapter

**lifespace-adapters / Environment `production`**:
- Existing Cloudflare credentials and reviewed `MCP_PRODUCTION_*` Worker/name/origin settings
- `MCP_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET` — exact same plaintext as LifeSpace's protected `LIFESPACE_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET` (never store it in GitHub files or an Actions input)

Protected GitHub Environment approval must be enabled for these Owner operations. Source, PR, Issue, CI output and screenshots never contain actual credential values, live private IDs, personal records or D1 exports. No Staging secrets are reused. Do not silently turn on Production CIMD/DCR; the Console admission policy decides.

## B. Exact order / 生产上线严格顺序

1. **Lock accepted SHAs**: LifeSpace main candidate must pass full CI and owner-run `staging-deploy.yml`; Account code candidate also passes the independent `lifespace-account-staging-deploy.yml` if altered. Adapter main candidate must pass exact-SHA CI and owner-run `deploy-mcp-staging.yml`. Any Adapter workflow/source change changes its SHA and requires a new Staging release.
2. **Private Adapter only**: Owner manually runs [Adapter private Production preparation](https://github.com/huangshirui/lifespace-adapters/actions/workflows/deploy-mcp-production-private.yml) with `PREPARE_PRIVATE_MCP_PRODUCTION` and `STAGING_MCP_E2E_VERIFIED`. The protected Resource Secret is atomically injected with the **first private Worker deploy** via a 0600 temporary secrets file deleted by the runner. Neither Workers.dev, preview URLs nor public routes are activated.
3. **Canonical Core/Identity Production**: Owner manually runs [LifeSpace Production deploy](https://github.com/huangshirui/LifeSpace/actions/workflows/production-deploy.yml) with `DEPLOY_PRODUCTION`. Same-SHA Staging, APAC perf, source review, schema compatibility and D1 Time Travel availability are checked before migrating or replacing Production. Core is migrated/deployed, then Identity; existing signing keys, Service runtime and independent secrets are preserved.
4. **Protected first-time Account**: Owner manually runs [Account Production first-use provisioning](https://github.com/huangshirui/LifeSpace/actions/workflows/lifespace-account-production-provision.yml) with `INITIALIZE_ACCOUNT_PRODUCTION_ONCE` **only when Core and Identity already match the reviewed Production candidate**. It:
   - rejects existing Account/OAuth installation or partial secret setup instead of rotating anything;
   - clones and revalidates existing Production Console's **exact email-only owner Access policy** to protect `account.aisr.online` before the Worker gets a route;
   - creates only a limited LifeSpace Account Application with the reviewed profile/Space scopes and registers the verified Access Audience, returning a one-time `lsa_*` credential only inside the protected ephemeral job;
   - deploys independent Account Worker with no D1 or Platform Admin executor, injects Account CSRF/backend credential, pairs `OAUTH_CORE_APPROVER_SECRET` between Core/Identity, and installs Identity's Resource Secret to match the private Adapter. Verification checks secret **names**, exact same-environment Service Bindings and Access, never prints plaintext.
5. **Production smoke**: verify Cloudflare Access first, OAuth Issuer/PKCE, protected Resource metadata, Account consent/CSRF, actual OAuth MCP query, a deliberate User Delegation, revocation/denial, no cross-Space/token widening and safe data attribution. DCR/CIMD only after explicit Policy review. Log specific unverified optional negative E2E test exceptions; do not mark them PASS.
6. **Later routine Account-only releases**: Owner runs [Account Production code deploy](https://github.com/huangshirui/LifeSpace/actions/workflows/lifespace-account-production-deploy.yml) with `DEPLOY_ACCOUNT_PRODUCTION` only after the **same SHA** Account Staging deployment. It is forbidden to create or rotate secrets, change Core/Identity, alter Access policies or migrate data.

**Partial failure:** Never rerun first-use provisioning against an existing Application to mint new credentials or rotate paired secrets. Halt and prepare an independently reviewed recovery/cutover procedure. Do not revoke any valid old credential until a new one is verified live.

## B.1 Existing Production MCP Resource Secret recovery / 已上线连接恢复 (#585)

Do not rerun first-use Account provisioning. A real OAuth token exchange can succeed while MCP discovery fails if Identity rejects the Adapter's private introspection credential. The independent Owner-only [Repair private MCP Production resource secret](../.github/workflows/lifespace-mcp-production-secret-repair.yml) workflow consumes the existing protected LifeSpace Production Resource Secret, checks the exact Production bindings and canonical enabled MCP Resource, and proves the secret against live Identity with a synthetic unissued bearer. If the canonical secret is not accepted, it stops without mutating either Worker. If the actual MCP wire already returns the expected invalid-token challenge it is a no-op. If it returns 503, it writes only that same secret to the existing private Adapter; the result is successful only after the public Core → private Adapter → Identity path rejects the synthetic token with the exact 401 challenge. Never log credential values or change the Identity secret, Core, Account, grants, or business data. Owner confirmation: REPAIR_MCP_RESOURCE_SECRET plus the exact configured Production Resource URI. This is a scoped recovery, not a code deploy; future Adapter redeploys must preserve the same protected value in the Adapter repository's production environment. Real user consent → token → tools discovery → read → revoke remains a separate acceptance gate, not inferred from the negative probe.

## B.2 现有 Secret 不可恢复时：Owner-only 成对轮换 / Lost-Secret Pair Rotation (#649)

> **用户已同意短暂停止生产 MCP。** 本节是本期预备操作手册，不代表轮换已发生。该项只涉及 OAuth Resource Server 与其私有 MCP Adapter 的认证密钥；不会修改 OAuth 签名密钥、Access/Refresh Token、User Delegation、Account CSRF、Core OAuth Approver，也不会重建 Account Application。

1. **在可信本地终端生成一次新的随机密钥**：`openssl rand -base64 48`（48 随机字节，384 bit；请直接存入密码管理器）。不要贴到 ChatGPT、GitHub Issue/PR/Actions input、公共终端日志中。
2. **操作前分别更新 GitHub Environment `production` 的两个受保护 Secret 为同一个新值**：
   - LifeSpace 仓库：`LIFESPACE_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET`
   - lifespace-adapters 仓库：`MCP_PRODUCTION_OAUTH_RESOURCE_SERVER_SECRET`
   
   GitHub Secret 无法读回旧值，因此必须由操作者从同一个可信保存位置粘贴两次。不要重用 Staging Secret。配置完毕前**不可**触发生产轮换，也不要再次触发 Adapter Production 失败的候选值。
3. **运行新增独立的 [Rotate Production MCP Resource Secret pair](../.github/workflows/lifespace-mcp-production-secret-rotate.yml)**，仅由仓库 Owner 在 `main` 上手动 `workflow_dispatch`：
   - `confirmation`：`ROTATE_MCP_RESOURCE_SECRET`
   - `resource_uri`：从当前 Console / MCP 客户端配置中复制**已经启用的**、准确的 Production URL，格式 `https://core.aisr.online/mcp/mcp_<32-hex>`
   - 此 URL 是 Resource 定位符，不是密钥；**Secret 只能来自 GitHub Environment**，绝不使用 Actions 明文输入。
4. 工作流将首先对 Cloudflare 的现有 Identity/Core/Adapter **只读**核查、核对真实 Protected Resource Metadata，使用从未签发的合成 Token 测试候选密钥和 MCP 认证响应；然后**仅更新** Identity `OAUTH_RESOURCE_SERVER_SECRET`，验证新密钥被 Identity 认可；随后**仅更新**私有 Adapter 同名 Secret，等待真实 Core→Adapter→Identity 路径用未签发 Token 返回正确的 `401 invalid_token` 挑战。Workflow 不修改应用代码、Core/Identity Schema、Account、真实用户 OAuth Token 或授权。
5. **短暂中断**：Identity 先切、Adapter 后切，中间的 MCP 工具/发现可能临时返回错误或不可用；已签发 OAuth Token 和 `dlg_*` 不会因为本次密钥切换被主动吊销。**无旧密钥回滚**：如果中途失败，必须先诊断状态，再使用**同一把已保存的新密钥**重跑这条受控工作流。不能再生成另一把临时密钥或重跑 `First-time provision LifeSpace Account production`。
6. 成对轮换通过后，从 Adapter 仓库按其受保护发布门禁运行 [MCP Adapter Production](https://github.com/huangshirui/lifespace-adapters/actions/workflows/deploy-mcp-production-private.yml)。它会单独核对其候选 Environment Secret 是否与 Identity 相符，并发布已验收代码。之后按 [Platform Production](https://github.com/huangshirui/LifeSpace/actions/workflows/production-deploy.yml)、[Account Production](https://github.com/huangshirui/LifeSpace/actions/workflows/lifespace-account-production-deploy.yml) 正常流程发布；**新 GitHub main SHA 必须先完成精确相同 SHA 的 Platform Staging 和 Account Staging 门禁**。
7. **最终验收**：从真实客户端用 Production OAuth/PKCE 执行受限 MCP 发现、授权读取、审批及逐项撤销，明确验证正确结果；轮换工作流的合成 Token 401 只证明认证边界，不等于正向业务验收。**日志不得包含新旧 Secret 明文、Token 或业务记录。**

注意：旧的 [Repair private MCP Production resource secret](../.github/workflows/lifespace-mcp-production-secret-repair.yml) 只适用于 LifeSpace Environment Secret 已被当前 Identity 接受的旧式单侧修补，不具备成对轮换能力，也不会帮你同步 adapters 仓库的 GitHub Secret；请勿混用。

## C. D1 recovery, public repo hygiene / 迁移与备份

Live Production starts from Core schema 76 and Identity schema 14, whereas the accepted target candidate is Core 78 and Identity 18. The canonical release now invokes `infra/scripts/verify-production-d1-time-travel.mjs` before any migration. It checks both Production databases' exact schema, refuses downgrade, and retrieves Cloudflare Time Travel bookmark availability **read-only**. Its safe summary exposes no bookmark, D1 UUID, raw records or backup export in Public Actions.

Time Travel restores are **destructive** and may erase new Production writes. Any rollback requires a separate Owner authorization and consideration of writes since the checkpoint. Cloudflare's retention depends on plan (potentially 7 days on Free and up to 30 days on paid). Code rollback is not a D1 schema downgrade. A forward-compatible repair is preferable if active writes cannot be lost.

Official references: [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) and [Workers secret deployment](https://developers.cloudflare.com/workers/configuration/secrets/).

## D. Gate checklist / 发布前的检查结果

- [ ] Owner has configured protected Environment secrets in **both repos**, with the exact resource secret pair
- [ ] Exact reviewed main SHAs; complete CI; new LifeSpace and Adapter Staging runs accepted
- [ ] Private Adapter Worker is installed without a public route
- [ ] Both Production D1 Time Travel bookmarks are available before any migration
- [ ] Core/Identity canonical Production deploy passes version/perf/bindings/migrations
- [ ] Protected Account first-use workflow passes access/credential/OAuth checks
- [ ] Production smoke/revoke and explicit rollout sign-off recorded
- [ ] `docs/production/` capability guide, matrix and changelog updated **after real deployment**, never prematurely

Enhancements deferred by the Owner: full Space subpages, cross-app Delegation list, External Connection management UI, full user-facing activity audit; optional MRTR/Template UX, External Delete and noncritical Account mobile/profile usage checks. These deferrals do not waive OAuth, Space/Grant, Access/CSRF, data safety or rollback.

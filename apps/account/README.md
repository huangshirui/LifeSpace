# LifeSpace Account · User Center + OAuth Consent / 账户中心与授权门户

## 2026-11-10 · Account Staging 独立发布 / 解除跨服务密钥耦合

- **普通更新**：只使用 `.github/workflows/lifespace-account-staging-deploy.yml`，完成完整 CI、Core/Identity 版本兼容、Owner-only Cloudflare Access 策略以及三个 Staging Worker Secret 绑定**名称**的只读检查，随后仅对 Account Worker 运行 `wrangler deploy`。已有 Account Worker Secret 自动保留；不会重签 `lsa_*`、升级 Identity Application、部署 Core/Identity、变更 OAuth Shared Secret 或运行数据库迁移。
- **显式初始化/轮换**：只有建立/修复 Account 接入、批准的 Scope/Access 配置变更或主动密钥轮换，才运行 `.github/workflows/lifespace-account-staging-provision.yml`，必须由 Owner 从 `main` 手工触发且输入 `PROVISION_OR_ROTATE_ACCOUNT_STAGING`。该特殊流程会对 Core/Identity Staging 执行 `wrangler secret put` 并可能重新部署相应 Worker，不能当成普通 Account 部署。
- **平台独立性**：`staging-deploy.yml` 只有在 Core/Identity 的源码、Schema、契约或配置确实需要变更时执行。普通 Account 更新不再要求先重新部署平台。两个 Account 工作流和 Platform Staging 共享并发锁，均不自动触发。
- **安全**：没有持久 Account 数据库；正常发布不读取 Bootstrap Secret，不读取/输出任何 Secret 明文。已有 Staging 若尚未从三 Scope 升级为获准的五 Scope，需先明确执行一次维护流程，不能普通部署时偷偷扩权。详细前置与验证条件见 [STAGING.md](./STAGING.md)。

## 2026-11-10 · 资料只读与退出登录

- 「账号与安全」中的姓名和邮箱输入框默认 `readonly`；只有用户点击该字段独立的「编辑」才允许输入和保存；「取消」恢复已确认数据，成功保存后回到只读。姓名编辑不替代邮箱变更的再次确认与待验证流程。
- 「退出登录」按钮必须经用户确认后导航至当前应用**同源** `/cdn-cgi/access/logout`。Cloudflare Access 会撤销当前用户在同一 Access Team 下的会话（不是仅本 Account 页面）；其他受保护应用可能需要重新登录，令牌失效可能有短暂传播延迟。此操作**不撤销 Identity OAuth Authorization / Core Delegation / Service Credentials**。不引入 Account 自建 Session/Auth 或跨域登出 URL；工作流仍由 Owner 手动部署。

## Account Center 用户体验与自助操作（候选 v0.4.0，待 Staging 验收）
 
 - 保留四栏用户账户中心，统一 Lucide SVG、布局和简洁中文文案；OAuth 技术标识默认收在“技术详情”。
 - Account 应用本期明确允许 `profile:read`、`profile:write`、`spaces:read`、`spaces:write`、`spaces:manage`。浏览器只通过同源 BFF 操作，写操作带用户会话、Origin、Fetch Metadata 和 HMAC CSRF；Identity/Core 是最终权限权威。
 - Identity 用户资料：更新姓名、头像和已声明登录邮箱（变更后待验证，不证明新邮箱所有权，某些原邮箱的 Access 登录关联可能失效）。
 - Core 通用 Space：创建空间、预览邀请码和确认加入；**不把任意 Space 自动注册为 HomeMew 家庭**，HomeMew Web 暂不修改。
 - 日常委托管理的旧 `/delegations` URL 导向 `/center#connections/delegations`，第三方 AI 的独立 `/delegation` 交易批准页保持不变。
 - Agent/Service API 与 Event Push 的用户级治理、完整 Delegation/操作审计继续按 #514 实施。Production 尚未发布。
 
 ### 历史只读候选说明
 
## Account Center 本期页面（开发候选，未部署）

- `/` 由 Account Worker 302 跳转至 `/center`，`/center.html` 为静态页面文件；`/oauth/consent` 与 `/delegation` 保持独立的授权交易入口，不能因主页切换破坏 OAuth 回调与独立委托。
- V7 UX 调整版只作为视觉与用户旅程参考。导航：账号与安全、我的空间、连接与授权、活动与审计；用户头像/姓名/邮箱区域必须来自验证的 Identity 用户及已声明邮箱。无模拟记录、无独立「总览」页，不新增 Account D1 或通用 conn_*。
- 新增 Account BFF 只读接口 `GET /api/account/login-email`、`GET /api/account/spaces`、`GET /api/account/spaces/:spaceId` 和 `.../members`。每次使用当前 Access→Identity User Token 调 Identity/Core，并由上游执行当前权限检查；不缓存 Authority，不把 User Token 交给浏览器。
- Delegation 标签页调用既有 `GET /api/delegations` 和带 CSRF 的撤销操作，逐项展示并真实刷新服务器状态。OAuth Authorization 列表与单独撤销现通过 Identity 用户级 API 接入；Agent/Service/API、Event Push、用户审计尚缺真实 user-scoped 管理契约；External Data 列表已可通过 Core 当前 Space Manager 读权限获取非敏感元数据，但创建/轮换/撤销仍需要独立治理流程，页面**明确标注待接入**，不可误报为“空列表”或已完成；见 #481 与 #514。
- Account Center 本身只是 Exposure/Experience；用户资料变更、Space 创建/邀请/修改和完整安全审计等后续功能必须依照 Identity/Core 本来的授权模型独立验收；OAuth 授权撤销已由 Identity 自助接口承担，仍待 Staging 真正验收。不要将只读页面合并等同于这批完整 Production 交付。



Account is an **independent user-facing** LifeSpace Worker, not the Platform Admin Console. It provides Account Center read-only identity/Space views, current-user OAuth Authorization list/revoke, Delegation self-management and Space-manager External Connection metadata. Full security audit and broader Agent/Service/Event governance still require governed user-scoped APIs. No generic Connection Registry or Account D1 is introduced.

## Browser journey / 用户流程

1. OAuth `/oauth/authorize` creates a pending request and redirects to the configured `OAUTH_CONSENT_URL` (`/oauth/consent?request_id=oar_*`).
2. Account's Cloudflare Access-protected hostname provides the raw `Cf-Access-Jwt-Assertion` only to the BFF; Identity maps it to the registered Account Application and issues a short-lived User token. The BFF holds the token only for the current server-side request.
3. Account displays the *unverified* Client name/redirect origin, exact Resource, requested OAuth scopes and eligible manager Spaces, and presents only Agent/Application candidates with current Space Data Grants and active Identity bindings.
4. User explicitly selects Application, Space, Agent, and either Direct or **allow requests for user authorization** (not granted Delegation), then clicks Confirm.
5. The BFF checks exact Origin/Fetch Metadata, an Account-user-bound HMAC CSRF token and explicit intent; Core rechecks current Space manage + Agent eligibility and calls Identity's private approval bridge.
6. Only then does the browser follow Identity's registered OAuth callback carrying one-use Code.

This **does not** yet compute final tool-level effective Core permissions. The UI labels Grant summaries as informational upper bounds, not actual executable capabilities. Never claim real MCP OAuth support until Adapter and browser E2E tests pass.

## Secrets / 发布前条件

Register dedicated LifeSpace Account Application and Access Audience. Inject the Account `lsa_*` credential into `IDENTITY_APPLICATION_CREDENTIAL`, the independent HMAC `ACCOUNT_CSRF_SECRET`, and corresponding `OAUTH_ACCOUNT_APPLICATION_ID` in Core + Identity; provision `OAUTH_CORE_APPROVER_SECRET` to Core/Identity only. No plaintext secrets in GitHub. Keep Account behind Cloudflare Access and ensure `Cf-Access-Jwt-Assertion` is not accepted from unauthenticated public requests.

The Consent UI now displays a conservative Agent Direct Native model access upper bound from Core's current Application × Model Access and Agent Space/Model Grants, further intersected in the BFF with the actual pending OAuth Scope. It is explicitly **not** a guarantee of executable tools because Model Policy, external models, published MCP resource/tool constraints and delegated user authorization still narrow later execution. The UI refuses to confirm if the preview cannot be retrieved.

Staging readiness: run `node apps/account/scripts/check-staging-readiness.mjs` with a **read-only** Cloudflare API token and Account ID. It must find a separately protected account-staging host, strict per-email Access policy, staged Account Worker and converged Identity/Core contracts. Private Account Application/Audience and Secret checks remain manual, with fail-closed status until verified. This readiness script never mutates Cloudflare.

The owner-triggered Account Staging workflow generates its two dedicated Staging secrets on the protected runner (no manual secret-copy step); each redeploy rotates CSRF sessions and the shared Core↔Identity Staging approval secret. Original existing platform staging credentials are still required.

Staging is not implied by a merge or CI result. The repository owner must first deploy the reviewed platform main release, then the Account Staging Worker and verify its actual browser/OAuth/Delegation behavior before Production. Run `pnpm --filter @lifespace/account check` for local tests and Worker dry-run.

## Third-party OAuth User Delegation lifetime choices (2026-11-09 candidate)

The Account `/delegation?request_id=arq_*` page offers the user (not the OAuth Agent) once (default, 30-minute one-use), timed (1 hour / 24 hours / 7 days of repeated exact-model-operation use), or indefinite until revoked. This is a second consent event, not the initial OAuth execution-mode switch. All decisions require the current Account User session, strict Origin/Fetch Metadata, signed CSRF and Core's fresh authority checks. A recurring authorization remains bounded to the approved Client, Resource, Space, model and operation; it is not a general write grant.

`/delegations` and its Account BFF APIs list and revoke the signed-in User's active `oauth_mcp` delegations independently of current OAuth status. Revocation does not undo previous writes. This is development source, not deployment proof.


## Account Center first-load optimization (candidate 0.5.0)

The Account Center requests `GET /api/session?include=login-email` once. Account verifies the same original Access assertion via Identity, then loads active-user profile and declared login mailbox concurrently with the same request-local user credential. Profile remains mandatory; mailbox failure projects null and disables editing until refreshed. Default `/api/session` and isolated OAuth/Delegation pages retain their original behavior. The standalone mailbox endpoint remains available. No persistent session/authority cache, new scope, Identity/Core route change or cross-service data access. Initial profile/email transport: two browser requests and five Identity binding calls become one browser request and three binding calls, in two sequential stages. Actual page latency requires Staging verification.

## 2026-11-17 · 通用空间设置与生命周期（candidate 0.7.0，未部署）

用户确认 Account 是通用账户与 Space 用户自助管理入口；上层应用只负责产品特有体验，保留现有 HomeMew 通用管理直至 Account 成熟且等价验收。Core/Identity 继续拥有 API、数据和权限权威。第一切片在空间详情打开独立编辑/退出/注销弹窗，调用固定同源 POST 路径 update/close/leave，当前 User Token 转发 Core PATCH/POST；严格 Origin、Fetch Metadata、CSRF、intent 和确认 Space ID，更新与关闭带原始 version。Owner 注销为既有 Core 逻辑关闭，不是永久删除或可恢复归档；非 Owner 退出由 Core 判定。无新增 Scope、Core/Identity 路由、DB、迁移或 HomeMew 修改。成员/邀请/头像和完整子页继续 #514，待 Staging/Production 实测。

## 2026-11-17 · 空间管理完整子页候选 0.8.0（未部署）

空间概览、成员、邀请、设置四个子页，支持 `#spaces/<spaceId>/<tab>` 导航；仅列当前成员空间，邀请页仅经理角色可用且按需加载。成员角色调整使用 membership version，移除复用 Core 无 version 的生命周期，不能操作 Owner 或以 Account 绕过 Core。邀请角色/期限/次数受 Core 上限约束，完整邀请码只在创建响应/弹窗中显示一次，列表仅前缀；撤销不踢出已加入成员。头像沿用 Core multipart file/version，白名单同环境 Core 资产 URL；无新 Scope 或存储。新管理操作使用弹窗，权限和版本错误须刷新，不自动重试。HomeMew 保留现状。

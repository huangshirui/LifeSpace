# LifeSpace Account · User Center + OAuth Consent / 账户中心与授权门户

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

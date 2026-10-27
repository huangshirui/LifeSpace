# Identity Bootstrap 收敛 — Issue #93

> **目标：Bootstrap 只建立第一条可用的管理信任链，并支持明确的紧急恢复；日常治理统一归现有 Platform Admin。**
>
> 此 Issue 是**现有路由及调用方的收敛**，不是新建机器授权或 Provisioning 平台。

## 保留的架构边界

- 普通 Identity Application API 不承载 Bootstrap 管理职责；Identity Platform Admin 继续使用 **实际人类管理员 Actor proof + 同应用受控 Executor**。不能让 CI/脚本用固定 `usr_*` 模拟人类批准，不能为了消除 Bootstrap 而削弱这条边界。
- 首次初始化仍须能建立第一个 Application/Console Executor 和 Platform Administrator；失去正常管理能力时必须有显式 break-glass 入口。它们不得常驻普通 Console Worker。
- 凭证一次性返回明文、旧/新凭证重叠与独立即时撤销、准确的目标 Application ID、Access issuer/audience 唯一性和 Staging/Production 隔离都必须保持。
- **不属于 #93**：GitHub OIDC 授权平台、Machine Provisioning Lease、新的 Token/Grant/Schema/Worker、覆盖所有网络中断情形的分布式凭证事务。这些只有出现独立、明确的实际需求时才另建 Issue；不能作为关闭 #93 的强制步骤。

## 遗留 Bootstrap 操作：保留还是移除

| 路由 / 操作 | 结论 | 处理方式 |
| --- | --- | --- |
| `/bootstrap/v1/platform-administrators` GET/PUT/DELETE | 首次授权及显式恢复 | 核查当前使用方；保留必要的恢复入口，避免日常脚本依赖 |
| `POST /bootstrap/v1/applications` | 初始化第一条可信链必需；日常调用重复 | 首装保留必要能力；日常创建改为已有 Platform Admin |
| `GET/PATCH /bootstrap/v1/applications/:id` | 与 Platform Admin 重复 | 移除常规调用方后删除 |
| `GET/POST/DELETE /bootstrap/v1/applications/:id/credentials*` | 与 Platform Admin 重复 | 将轮换/回收移交已有管理员流程；部署和普通测试不要无谓重新签发 |
| `GET/POST/DELETE /bootstrap/v1/applications/:id/access-audiences*` | 与 Platform Admin 重复 | 使用已有治理入口；仅保留首次 Console 接入所必需的初始化步骤 |

当前 Identity 保留 **12 种按 HTTP method 计数的 Bootstrap 路由**。精确文件和引用数以 `infra/scripts/bootstrap-surface-inventory.mjs` 的递减预算为准；该脚本只防止新依赖扩张，**不是**新的权限系统。

## 审查现存调用方时的最小处置规则

1. **仅在第一次建立信任链 / 受控恢复时需要？** 归到 Seed/Recovery，不让它随日常部署循环执行。带固定 `app_*` ID 的首次创建不能盲目替换为会生成新 ID 的 Platform Admin POST。
2. **是真正的日常管理？** 直接使用已有 Console/Identity Platform Admin 的人工授权流程。部署工作流尽量只部署 Worker/配置，不顺便创建、旋转、扩大或回收 Credentials。
3. **只是测试前置条件？** 优先复用已配置、可撤销的最小权限 Fixture；需要刻意验证凭证创建/撤销的 Staging 验收可以保留显式受控的独立测试路径，不能将它等同于普通部署或人类在线授权。
4. **没有调用方？** 删除重复 Bootstrap 路由和普通 Identity OpenAPI 旧声明；任何删改都必须先通过消费者搜索、负向权限测试和发布门禁，不能只因存在 Platform Admin 同名 API 就直接删除。

优先审查 `prepare-staging-smoke`、`verify-staging-agent-ready`、Staging Console 独立验收，以及 Staging/Production Console provision、Application/Access Audience reconciliation。它们目前仍存在 Bootstrap 调用；不能在迁移前删除服务端路由。Console 默认的 isolated staging deploy 不应因为本 Issue 被改回每次全量 Provisioning。

## 已完成且保留的改动（2026-10-27）

- [#424](https://github.com/huangshirui/LifeSpace/pull/424)：现存 Bootstrap 调用/路由清单与 CI 不扩张门禁。
- [#425](https://github.com/huangshirui/LifeSpace/pull/425)：Identity `0.16.0` 新增只读 `GET /internal/v1/applications/self`，允许有效 `lsa_*` 检查**自身**非秘密 Application metadata；Staging Eventing 验收不再使用 Bootstrap PATCH 临时扩权。
- [#426](https://github.com/huangshirui/LifeSpace/pull/426)：三个 Console Staging 脚本将 Bootstrap metadata GET 改为自身 Credential 检查，并改进 Agent-ready 临时凭证登记。
- [#427](https://github.com/huangshirui/LifeSpace/pull/427)：补上 Staging Application 凭证测试中途失败时的精确撤销、错误脱敏与 fault-injection 回归。网络 POST 成功但响应彻底丢失仍是旧 API 的限制；不因此强制扩展 #93 的 API 范围。

**实际 Staging 证据**：Platform [#40484151501](https://github.com/huangshirui/LifeSpace/actions/runs/40484151501)（#427 对应 SHA `1486b463...`）成功；Console 三组独立验收 [#40476827104](https://github.com/huangshirui/LifeSpace/actions/runs/40476827104)（#426 对应 SHA `7f18463...`）成功。模拟错误路径的 CI 通过，但不是线上中断注入。**这不是 Production 部署凭证**，不得将本阶段写成 Production 已完成。

## #93 关闭条件（不添加新系统）

- 每条留下的 `/bootstrap/*` 路由都有可解释的首次初始化或 Break-glass 用途；普通 Application OpenAPI 不再暴露冗余管理入口。
- 普通部署/Console/自动化不再把 Bootstrap 当日常管理秘密；Application / Credential / Audience 的常规管理统一为已有 Platform Admin。
- Clean-room 首装与恢复路径可用；Credential/Access/权限隔离不回退；真实 Staging/Production 发布及 Golden Flow 分别在各自候选 SHA 上通过。
- **未完成之前 #93 保持 Open**。重大新授权需求应独立提案，不纳入本 Issue 的验收。

## Staging Console Provisioning 精简（PR #429 候选）

- `infra/scripts/prepare-staging-console-admin.mjs` 对 **已存在**的 Console Application，默认不再每次用 Bootstrap `PUT /platform-administrators/:userId` 重新授权。只有首次创建 Application 或明确指定 `LIFESPACE_STAGING_CONSOLE_RECOVER_PLATFORM_ADMIN=1` 才执行赋权；GitHub 手动工作流对应 `recover_platform_admin` 选项，默认关闭。普通流程不声称验证了现有管理员状态；后续真实 Console Admin 验收仍需验证授权，不可跳过。
- Existing Application Credential 使用已安装的 `lsa_*`，或者在 `LIFESPACE_STAGING_CONSOLE_ROTATE_CREDENTIALS=1` 时明确创建替换凭证。删除此前无论如何都会进行的 Bootstrap Credential LIST，以及“发现没有活跃凭证便静默自动新建”的路径。凭证确实丢失时通过**显式轮换**恢复，杜绝无意的权限管理副作用。
- 保留首次初始化所需的 Bootstrap `POST /applications`、管理员建立及 Access Audience Seed；不修改 Production 或现有 Platform Admin 接口。Bootstrap 调用方预算仅就此脚本由 7 缩至 6，CI 对退出路径与人工恢复门禁做结构测试。

## 平台 Staging 发布与 Console Scope 治理解耦（2026-10-27）

- 旧 `.github/workflows/staging-deploy.yml` 每次完成 Core/Identity 发布后，无条件执行 `reconcile-staging-console-space-scope.mjs`，使用全局 Bootstrap GET/PATCH/GET 检查并可能改写**另一个应用的** Console Scope Ceiling。这不属于日常平台版本发布，也使人工配置或撤销的 Scope 可能被下次无关部署覆盖。
- 移除该自动步骤及不再需要的脚本，移除静态 Bootstrap Consumer 白名单和相关 node-check；Console staging isolation guard 改为拒绝重新加入这一跨应用写入，并确保显式 `Converge LifeSpace staging control plane` 仍是 Application Scope 初始化/更新入口。
- **兼容性**：`prepare-staging-console-admin.mjs` 在人工触发的 Staging Provisioning 中，已经有 `reconcileApplication` 能对齐 Console Application Scope；[实际运行 #40499292472](https://github.com/huangshirui/LifeSpace/actions/runs/40499292472) 成功。后续发现 Scope 缺失应在 Console 的受控配置/Provisioning 中解决，**不要**依赖发布 Core/Identity 自动追加授权。
- 不新增任何 API/Scope/机器授权，不更改 Production。此 PR 的仓库检查不等于最新 SHA 的真实 Staging 发布验收。

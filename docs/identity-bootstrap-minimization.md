# Identity Bootstrap 收敛计划 / Issue #93

更新：2026-10-27。状态：Phase 1 inventory + CI ratchet（**未**删除接口、未迁移 Production）。

## 决策边界

Bootstrap 只负责建立首次可用的正常治理权限链，及明确受控的 break-glass 恢复。持续性的 Application / Credential / Access Audience 管理由 Identity Platform Admin 负责。平台管理员的人工 Actor proof 与机器的运维身份不可混同；不能让 GitHub Actions 伪造人工证明，也不能仅为方便部署而移除 Actor / Executor 双重校验。

此阶段保留当前发布合同和行为，增加 `infra/scripts/bootstrap-surface-inventory.mjs` 静态 CI 门禁：
- 对当前路由与每个既有调用文件设置上限，允许减少、不允许增长；
- 禁止向 Console Worker、未列入清单的脚本及新的 Identity router 引入 Bootstrap 路径；
- 在代码收敛过程中逐步降低计数与白名单，并在最后删除普通 Identity API 中冗余的 Bootstrap operations；
- CI 只检验依赖面不扩张，不代表既有使用安全、不代表用户人工验收通过，也不替代运行时权限校验。

## 现有服务端路由分类

| 路由族 | 操作 | 分类 | 最终方向 |
|---|---|---|---|
| /bootstrap/v1/platform-administrators | GET / PUT / DELETE | 初始管理员建立、显式恢复 | 保留必要操作但缩小权限范围，单独论证恢复审计 |
| /bootstrap/v1/applications | POST | 混合：初始信任链 + 日常脚本初始化 | 只保留首装必需部分，迁移 Smoke / 运行期创建 |
| /bootstrap/v1/applications/:id | GET / PATCH | 与正常管理面重复 | 调用方迁移后移除 |
| /bootstrap/v1/applications/:id/credentials | GET / POST / DELETE :credentialId | 与正常管理面重复 | 迁移并保留明文只返回一次、凭证重叠与即时撤销 |
| /bootstrap/v1/applications/:id/access-audiences | GET / POST / DELETE :audienceId | 与正常管理面重复 | 迁移并保留 issuer + audience 唯一性与撤销语义 |

当前服务端共 12 个路由（按方法计），6 条 Bootstrap Application path patterns 仍在普通 Identity OpenAPI。应用治理的对应正常接口位于 Identity Platform Admin companion contract；它们要求已认证 `lsa_*` Executor 和 <=5 分钟人工管理员 Actor proof。

## 现有消费者分组（2026-10-27 main）

- **首次初始化与紧急恢复**：Identity app seed、platform-admin assignment、Console 首次 Application / Executor / Audience 建立以及管理员恢复脚本。
- **常规管理/环境配置**：Console Staging/Production provision、范围 reconcile、凭证轮换与回收。
- **Staging 自动化**：Staging Smoke、Application Admin、Agent-ready、Eventing、Console control-plane/Space/configuration 验收。
- **Production 自动化**：Production Model Admin probe 与 Console cleanup/verification。
- **静态防护**：Console production deployment isolation guard 中只读的 Bootstrap 路径检查，并非运行时调用。

确切的文件与每个文件的遗留引用数以可执行的 `LEGACY_REFERENCE_BUDGET` 为准；增长将使仓库 `pnpm check` 失败。

## 已识别的迁移困难

1. 现有 Bootstrap 创建 Application 允许部署方指定固定 `app_*` ID，而当前 Platform Admin Create 自动生成 ID。不得直接改用普通 Admin POST 然后在脚本里猜测或复写新 ID。
2. Platform Admin 正常调用需要人工 Actor Token；非交互式 CI 不能冒用人工身份。优先调查是否可以把常规 Smoke 改成预置最小作用域、可撤销、只在测试环境有效的受控 Application/Service API；如确需新的受限机器控制面，必须单独审查 Authority、审计、授权范围与恢复流程。
3. 实际部署依赖可能隐藏于工作流内联 JS、Console acceptance 或临时资源清理，不能只扫描 OpenAPI 断言无依赖。
4. 在 Staging consumer/Golden Flow 验证前不得删除旧 API；Production 需满足精确 SHA 的 Staging → APAC → Production 发布门禁。该 Phase 1 不执行远程数据库/Worker 变更。

## 后续执行门槛

- Phase 2：提出并验证非交互式受限自动化方案（或无须新增 API 的替代），迁移可明确证明的调用方；Staging Clean-room 初始化、权限 deny-path、临时凭证清理覆盖。
- Phase 3：迁移 Production 及 Console 残余依赖，完成 Access Audience / credential lifecycle 和 Golden Flow；不留下跨环境 Scope 漏洞。
- Phase 4：移除已经没有调用者的重复 Bootstrap API，版本化 Identity OpenAPI/平台控制面合同，并运行生产发布后验收，才关闭 #93。

## 验收证据的真实性

本计划和相关门禁是**开发仓库代码**，不是 Production capability。不能更新 `docs/production` 声称 Bootstrap 已收敛；部署后才更新生产事实，并追加项目 Notion “99 · 架构演进与决策日志”。

## Phase 2 incremental slice（2026-10-27，PR 与 Staging 验收前）

- 新增 `GET /internal/v1/applications/self`：仅凭当前有效的 `lsa_*` 读取调用者自身 Application 非秘密配置，不接受 target Application ID，不提供 Credential 管理或范围提升。
- `verify-staging-application-admin.mjs` 原本对临时 Smoke Application 的 Bootstrap metadata GET 改为用该 Application 自己的凭证验证 live scope ceiling；其余 Bootstrap 凭证创建 / 撤销验收仍保留，不能在没有替代的管理员授权模型时删除。
- Identity Application Contract 增量升级 0.16.0，包含正反向权限测试；这一步不是授权 CI 操作其他 Applications，也未授权添加机器 Platform Admin 主体。
- **顺序要求**：使用更新后的 Staging Identity 服务做集成验收后才能依赖此路径，不能在部署 Identity 0.16.0 前单独运行更新后的验收脚本。生产合同与服务能力仍以成功部署的版本为准。


### Phase 2b：Staging Eventing / Principal Revocation 去 Bootstrap（2026-10-27）

- 当前 `prepare-staging-smoke.mjs` 初始化时已明确授予 `spaces:manage`、`grants:manage`、`resources:read`、`resources:write` Scope Ceiling；旧 Eventing 验收脚本为“Scope 不足时临时扩大并恢复”的 Bootstrap PATCH 分支不应存在。
- `verify-staging-eventing.mjs` 与 `verify-staging-eventing-principal-revocation.mjs` 改为用 Smoke Application 自己的 `lsa_*` 调用 `/internal/v1/applications/self`，必须检查当前返回的 Application ID、active/trusted 状态及所有必需 Scope；任一缺失直接失败（fail closed），不做提权、不做恢复 PATCH。
- 两个 Staging Eventing 验收脚本及其 runtime 环境校验均不再读取全局 Bootstrap Secret；从 `LEGACY_REFERENCE_BUDGET` 中永久删除这两项允许名单，CI 同时覆盖“不回引 Bootstrap”的负向回归。
- 注意：这是**代码**路径收敛，不是已经完成 Staging Golden Flow 的线上证据。需先部署新版 Staging Identity 0.16，运行实际 Eventing 验收后确认，无权修改 Production 或把变更提前写入生产能力手册。

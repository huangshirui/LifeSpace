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


### Phase 2c：Staging Console 只读自检、Agent-ready 凭证清理保护（2026-10-27）

- 已在 [Staging #40459795146](https://github.com/huangshirui/LifeSpace/actions/runs/40459795146) 验收的 Identity `0.16.0` 自检接口被三个 Console Staging 验收脚本复用：每个脚本先按旧受控 Bootstrap POST 创建临时 Console `lsa_*`，**立即登记 finally 撤销对象**，然后使用该凭证调用 `GET /internal/v1/applications/self`，校验返回的 Application ID、trusted/active 状态及 Scope Ceiling。只读应用元数据不再使用 Bootstrap GET。变更保留对 Credential CREATE/REVOKE 的原受控路径，不为 CI 新增权限。
- Bootstrap 静态 CI 限额从三个 Console 验收脚本的 `4` 各降到 `3`，并增加自检调用顺序、绑定当前凭证、身份/权限 fail-closed 和 finally 清理的结构测试。
- Agent-ready 原本 `Promise.all(agents.map(ensureApplication))` 会在一个调用失败后丢失另一个已成功返回的临时凭证 Context。现改为顺序登记每个成功创建的 Context，使后续失败时 finally 仍能撤销已登记的凭证。**局限**：如果单个 `ensureApplication` 已经创建凭证、但在返回前又失败，仍需后续专门设计创建事务/清理协调；此补丁不能声称完全解决所有中途故障。
- **明确未决的权限设计**：现有 Console Staging 验收脚本用 trusted Application `lsa_*` 为已知管理员 `usr_*` 换取 User Token，再获取 `platform_admin_actor` 并执行敏感 Platform Admin 测试。虽然有 staging-only 脚本隔离，脚本生成的 token 并不是独立人工证明。迁移剩余 Credential Governance 时**不得**把这一测试夹具当作获准的机器 Platform Admin 授权，更不能推广到 Production；后续应将机器运维能力建成带审计、目标边界和撤销能力的专属 Contract，或把需要人类 Actor 的路径保持为真实交互式验收。
- 本阶段只保证源码与静态/集成 CI 可验证；新分支未经实际 Staging Deploy 前，不得把三个 Console acceptance 的新 HTTP 顺序说成已在 Staging 实测，也不影响已经成功的 0.16.0 基础服务发布。Production 路径、Secrets、数据存储和管理端 Contracts 均不改变。


### Phase 2d：Credential issuance / cleanup failure-safety（2026-10-27）

- `verify-staging-application-admin.mjs` 原本在 Bootstrap 创建 `lsa_*` 后按顺序检查 Token exchange、撤销和被撤销凭证拒绝；任一中途异常都可能跳过 DELETE，遗留活跃的测试凭证。现在从 POST 响应中**立即登记返回的 `apc_*` ID**，之后用 `try/finally` 保证失败时再次尝试受目标 ID 限定的撤销。Credential 明文一返回就先添加 GitHub Actions mask，错误不再 stringify 含明文的创建响应。撤销失败不能被吞掉；针对 Token exchange 返回错误、意外 hash metadata 和首次 DELETE 失败的 fault-injection 回归测试进入根目录 `pnpm check`。
- `verify-staging-agent-ready.mjs` 不再等到 `ensureApplication` 完整返回才把 Context 注册到 finally：每次远程创建前即把 mutable Context 放进清理列表，收到初始凭证明文或临时 Credential ID 时立即填入。当首装 Bootstrap POST 未返回 Credential ID、而第一次 credential list 在创建后失败时，清理逻辑只能重新列出当前 active 凭证，以**唯一匹配的 secret suffix**定位并撤销；0 条或多条匹配必须失败，不能猜测其他活跃凭证。
- **未解决的分布式失败窗口**：POST 已在 Identity 提交但 HTTP 响应完全丢失时，调用方可能得不到新 Credential ID 或 one-time secret；这时无法仅靠旧 Bootstrap API 做确定性补偿。必须在后续专用 Provisioning Contract 中设计幂等请求 ID、服务端可查询的 issuance-operation ID、审计和受限回收，不允许在调用方按时间/模糊名称猜测并大范围撤销。现有 Staging 失败必须上报需人工介入的清理，而不能称为事务性保证。
- 本补丁只改 Staging 验收与静态/模拟测试，不添加 Credential API、不改变 Platform Admin 人工双授权、不修改 Production，也不增加 Bootstrap 调用/路由预算。

### 后续非交互式 Credential Provisioning — 待单独批准的设计边界

**此处是方案约束与实施门禁（🧭 Planned），不是已实现功能，也不是授权扩大：**

| 操作场景 | 长期采用的 Authority | 禁止做法 |
| --- | --- | --- |
| 浏览当前应用非秘密元数据 | 当前 active `lsa_*` → `GET /internal/v1/applications/self` | 用 Bootstrap GET / 擅自提升 Scope |
| 人类常规 Application / Credential 治理 | 当前 Platform Admin 人工 Actor proof + 受控 Executor + 审计 | 以普通 User Token / email / CI 的固定 `usr_*` 假装人工授权 |
| Staging CI 读取或业务验收 | 事先配置好的最小权限 Application/Service Credential | 为临时检查调用全局 Bootstrap 修改权限 |
| 真实非交互 Credential CREATE/REVOKE | **拟议** Identity-owned、明确批准的目标绑定 Provisioning Operation/Lease | 仅持有 `lsa_*` 即可自我永久续签；给所有 CI 一个全局 Machine Admin secret |
| 首次建立信任链 / 紧急恢复 | 人工明确授权的最小 Bootstrap / break-glass 流程 | 在日常 Console Worker 或常规运行时保存 Bootstrap |

如选择 Provisioning Lease，必须在独立 PR 中实现并验证下列硬约束后才能迁移消费者：

1. **可信机器 Actor，而非人类冒充**：只能从服务器侧验证的独立工作流身份或受控 Service Principal 建立来源、环境、仓库/Ref/Run ID；不可从请求 body 的 `actorUserId`、普通 `lsa_*`、单独的 GitHub 环境变量或未经签名验证的 OIDC claims 推导授权。首次授予/增权必须来自已认证的人工 Platform Admin 双授权或明确受控的 Break-glass。
2. **范围固定且不可自扩大**：授予时绑定 Staging/Production 环境、允许的一个或有限 `app_*` 目标、精确 operation（list metadata / create / revoke own issued credentials）、最多签发数量、到期时间和不可转授；拒绝跨目标/跨环境/通配管理。Production 的更换计划和回滚先于变更获批。
3. **短期、单用途、当前状态可撤销**：有限 TTL、幂等操作 ID、消费与重放拒绝、许可/执行身份变更立即失效。被授权创建新 Credential 不自动扩大原 Lease 或续签自身，尤其不能续写原持久机密凭证。
4. **安全写入与审计优先**：变更前必须持久记录 Machine Actor / 受控 Executor / Target / Intent / Run / Result（没有明文、哈希、Auth header）；审计失败应阻止变更。Credential one-time 明文只能交给受控 ephemeral Secret Sink；回收必须可精确指向已签发的 ID，不能在未知 ID 时猜测。
5. **否定路径/运维验收**：验证 Scope不足、非目标、错环境、过期、重放、重复创建、伪造身份、已撤销委托、审计失败、部分 HTTP 成功响应丢失、回收失败等全部 fail closed；确保 staging/prod 不共用 Credential/密钥。
6. **明确版本与治理**：Provisioning 归属 Identity 独立 privileged/automation contract；先写 OpenAPI、迁移、审计、负向测试与 Staging Golden Flow，再替换既有调用方并逐步下调 Bootstrap inventory ceiling。不得在普通 Identity Application OpenAPI 中悄悄复刻一个永久跨 Application Admin 平面。

在上述机制未设计、实施、验证前，Credential CREATE/REVOKE 的旧受控 Bootstrap 依赖**保持显式待迁移**；#93 不得关闭。

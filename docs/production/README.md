# LifeSpace Production Documentation

本目录是 **LifeSpace 当前 production 的人类可读事实入口（Human-readable Production Truth）**。

这里回答的是“线上现在真实能做什么”，而不是 North Star、目标架构、main 分支当前代码或 staging 已实现什么。

## 文档

- [`capability-guide.md`](./capability-guide.md) — 面向人的 Production Capability Guide / 生产能力手册；理解 LifeSpace production 时优先阅读。
- [`feature-matrix.md`](./feature-matrix.md) — 可快速扫描、检索的 production feature list。
- [`changelog.md`](./changelog.md) — 每次 production 发布成功后的用户/集成方可感知变化。

## 状态语义

- ✅ **Production**：已经由 production deployment 成功发布并完成该次 workflow 的验证。
- 🚧 **In development**：代码、PR、main 或 staging 中存在，但尚未由 production deployment 成功验证。
- 🧭 **Planned**：只有设计/计划，不代表实现。
- ❓ **Needs verification**：历史能力存在，但在本目录建立时缺少可追溯的 production release evidence；不得据此断言为最新 production 能力。

## 发布维护规则

1. merge、main、staging 成功都不能把能力标记为 ✅；只有对应 candidate SHA 的 production workflow 成功后才可以。
2. 每次 `Deploy LifeSpace platform production` 成功后，必须更新本目录，使其对应刚刚发布的 production。
3. 更新至少包括：production SHA/日期、能力增删改、Feature Matrix 状态、已知限制，以及 Changelog。
4. 文档只描述已部署能力；正在开发的能力可以列出，但必须明确标记为 🚧，不得混入 production 事实。
5. 若一次 production 发布没有用户可感知的能力变化，也必须更新 release metadata，并在 Changelog 写明“无能力层变化”。
6. 若 production workflow 成功但文档尚未同步，该次发布流程视为**未完整收尾**。

## 与其他文档的关系

- `docs/north-star.md`：长期方向与决策镜头，不声明已经实现。
- `docs/architecture.md` 等：当前目标架构、规范与工程边界。
- OpenAPI / Model Contract / tests / implementation：机器可验证事实来源。
- **本目录**：将上述事实按“当前 production”做版本冻结和面向人的解释。

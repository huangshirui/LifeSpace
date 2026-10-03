# LifeSpace Production Changelog

本文件只记录**已经成功发布到 production** 的变化。开发中、staging、PR 或 main 上的变化不得提前写成 production changelog。

## 2026-10-03 — Production documentation baseline established

这是 Production Documentation 机制的建立时间，不代表一次新的 production deployment。

- 新增 Production Capability Guide；
- 新增 Feature Matrix；
- 建立 release metadata / exact SHA 绑定规则；
- 建立“production workflow 成功后必须同步文档，才算发布完整收尾”的规则；
- 对无法从历史文档精确绑定到 production release SHA 的能力使用 `❓ Needs verification`，不进行猜测。

### Release metadata

- Production deployment SHA: **not backfilled**
- Reason: 在本机制建立前，仓库没有保存“最后一次成功 production deployment SHA → 人类可读 feature snapshot”的映射。
- Required next action: 下一次 `Deploy LifeSpace platform production` 成功后，以该次 exact candidate SHA 建立首个完整 release-bound changelog 条目，并同步 Capability Guide / Feature Matrix。

---

## Entry template for future production releases

```md
## YYYY-MM-DD — <short release title>

### Release metadata
- SHA: `<exact production workflow candidate SHA>`
- Core contract/schema: ...
- Identity contract/schema: ...
- Active Model Contract: ...

### Added
- ...

### Changed
- ...

### Removed / deprecated
- ...

### Known limitations
- ...

### Human-readable impact
- 对普通用户 / consumer app / Agent / operator 有什么变化。
```

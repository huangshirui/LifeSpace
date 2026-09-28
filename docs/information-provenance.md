# Information Provenance

Status: **Current architecture boundary**

## 中文摘要

LifeSpace 不再提供通用 Resource Provenance envelope，也不再维护 `resource_provenance` 这一套独立存储/版本继承协议。

Provenance（信息来源）与 Operation Attribution（操作归因）是两件不同的事：

```text
Operation Attribution
  Application / Principal / Actor / Delegation / Change

Information Provenance
  某个业务事实或记录来源于什么业务对象/来源
```

当前规则：

- Provenance 不属于所有 Resource 都必须携带的平台 envelope；
- Core 不接受通用 `provenance` create/update 字段；
- Model Contract 不自动生成 `provenance` 字段；
- 不保留旧 `resource_provenance` 表或旧数据兼容；
- Provenance 应通过普通业务 Relation 表达；
- 需要来源语义时，由 Model Definition 的 Relation 使用轻量语义角色，例如 `semanticRole: provenance_source`；
- 是否需要固定 source version、同步模式、外部查询方式等，属于具体业务 Model / 外部数据源模型语义，不放进 Authority / Delegation / Change；
- Federated Truth 另行设计，不预埋到当前 Provenance 或 Authority 模型。

## Boundary

LifeSpace treats Information Provenance as **business modeling semantics**, not a universal resource metadata plane.

A durable provenance relationship is represented by an ordinary model relation when the business model needs it. The relation participates in the same model validation, query, authority and lifecycle rules as other business relations.

Conceptually:

```text
Business Record
  relation -> Source Record
  semanticRole = provenance_source
```

The platform does not infer trust, truth quality, medical authority, confidence, synchronization authority or federation semantics merely because a provenance relationship exists. Those meanings remain explicit domain-model semantics.

## Retired design

The following former V0.1 design is intentionally removed without compatibility migration:

- generic `provenance` request/response envelope;
- `source / sourceRef / derivedFrom` platform metadata shape;
- `resource_provenance` versioned storage table;
- inherited effective Provenance across resource versions;
- special single-record GET Provenance projection.

Existing data in that representation is not migrated. Consumers must model required source relationships explicitly under the new business model.

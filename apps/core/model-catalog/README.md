# Shipped Model Catalog

`baseline-models.json` is the **single editable repository source** for the baseline Model Definitions shipped with LifeSpace Core today:

- Task（任务）
- Wish（愿望）
- Day Record（日子记录）
- Event（日程事件）
- Person Group（人员圈子）

## What is canonical

Edit the full logical Model Definition only in `baseline-models.json`.

Runtime/test exports in `src/builtin-models.ts`, deployment semantic projections, contract generation inputs and verification must derive from this catalog rather than copy its fields, actions, descriptions or policies into another editable source.

## Historical migrations

SQL migrations under `apps/core/migrations` are immutable **publication history**, not the current semantic authoring source. They intentionally retain the exact Model Definition snapshot that was published at that migration point.

When the shipped catalog changes:

1. validate the new canonical definition through the normal Model Definition validator;
2. classify compatibility explicitly;
3. add a forward convergence migration when deployed/fresh Registry state must advance;
4. never rewrite an already-shipped historical Model Definition row;
5. keep the fresh-migration catalog integration test green so the final current `published` Registry state exactly matches this catalog by model key, definition and schema hash.

## Model version versus semantic identity

Registry `version` is monotonic **inside one environment** and may differ between fresh, staging and production histories. Do not use an exact environment-local version number as the cross-environment semantic identity of a model.

Use the validated definition / schema hash and an immutable `mct_*` Model Contract Revision for semantic and contract identity. A concrete runtime record still carries the exact `modelVersion` that created it, but tests should compare that value with the current published Registry version unless the version number itself is what the test is explicitly exercising.

## Future Domain Packs

This catalog location does not decide the eventual physical Domain Pack（领域包）package structure. Contract Baseline first establishes one semantic authority. A later extraction may move a model into a pack, but must preserve the same rule: one editable definition source, derived projections, immutable publication history.

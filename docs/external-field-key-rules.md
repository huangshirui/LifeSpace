# External Field Key Rules / 外部字段 Key 规则

External Provider field identity and public LifeSpace field keys are separate concepts.

- `sourceFieldId` is the Provider-stable field identity used only for reconciliation/Adapter execution.
- `key` is the stable LifeSpace field identity exposed to API/App/Agent consumers.
- `title` / `description` are current semantic metadata and may change after Provider rename.

First assignment is deterministic and does not depend on AI/translation:

1. A simple ASCII Provider title is normalized to a legal lower-camel LifeSpace Field Key (`Start Date -> startDate`, `first_name -> firstName`).
2. A title that cannot be normalized directly (for example Chinese/Japanese/emoji) falls back to `field<stable sourceFieldId hash>`.
3. A reserved/colliding semantic candidate keeps its semantic base and appends a stable `sourceFieldId` hash suffix (`ID -> id<suffix>`). If that bounded candidate is also occupied, Core uses a longer `field<hash>` fallback.
4. The chosen `sourceFieldId -> key` binding is persisted independently from the replaceable latest schema snapshot. Provider rename never regenerates it.
5. Deleting and recreating a same-name Provider field with a different `sourceFieldId` creates a new identity and cannot silently inherit the retired key.
6. Schema refresh resolves the persisted binding as authoritative before persisting the latest snapshot, including under concurrent refresh attempts.
7. Refresh lookup cost is bounded by the current discovered field set and its candidate keys; Core does not scan all historical bindings for the model.

These rules supplement `docs/external-models.md` and exist to keep the generated API contract readable, stable and provider-neutral.

# Contracts Package Agent Instructions

`packages/contracts` is the versioned publication surface derived from canonical service contracts.

## Rules

- Canonical API syntax lives with the owning service, not here.
- Do not hand-edit generated contract artifacts.
- Published artifacts must identify the source service contract/version.
- Keep Core and Identity contracts distinguishable even when published together.
- Downstream apps must pin an explicit compatible version; do not introduce an implicit `latest` dependency.
- Any manual Markdown index in this package may explain generated artifacts but must not redefine request/response semantics.

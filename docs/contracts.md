# LifeSpace Contract Strategy

## Ownership

Canonical service contracts live with the service implementation in this repository. Core API syntax will be owned by `apps/core/openapi.yaml`; Identity API syntax will be owned by `apps/identity/openapi.yaml`.

Do not create a separately hand-maintained contract repository.

## Published artifacts

`packages/contracts` is the reproducible publication surface for versioned contract artifacts such as generated TypeScript types, JSON Schema/OpenAPI bundles and stable Markdown indexes. `packages/client` is the generated or thin handwritten SDK surface built against an explicit contract version.

Generated output must be reproducible from canonical contracts and must never become a second editable source of truth.

## Downstream applications

ALOHA, HomeMew and vertical apps must depend on an explicit compatible contract/client version. They must not fetch an unversioned latest contract during normal builds.

For Coding Agents and repository-local development, an application may check in or generate a read-only contract snapshot containing the exact version it consumes. Such snapshots are generated artifacts and must not be edited manually.

## Compatibility

- Additive compatible changes remain within the current API major version when semantics are preserved.
- Breaking request/response or behavior changes require an approved compatibility strategy, such as a new API major version or a supported transition period.
- Core deployment and contract publication are coordinated, but applications release independently and may temporarily consume different compatible contract versions.
- Planned endpoints or fields must be clearly distinguishable from implemented/deployed ones before clients are allowed to call them.

## Required checks

Changes to public API behavior should fail CI when canonical contracts, implementation and generated/publication artifacts drift. HomeMew's current OpenAPI contract-check pattern is a reference for this discipline, not a contract to copy unchanged.

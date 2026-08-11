# LifeSpace Contract Strategy

## Ownership

Canonical service contracts live with the service implementation in this repository.

Identity API syntax remains explicitly owned by `apps/identity/openapi.yaml`.

Core contract input is split into:

1. explicit Kernel API definitions;
2. validated/published Model Definitions;
3. registered Capability contract contributions.

`apps/core/openapi.yaml` remains the reproducible, versioned canonical publication artifact consumed by applications and checks, but ordinary model paths/schemas must not become separately hand-maintained sources of truth once the generator owns them.

Do not create a separately hand-maintained contract repository.

## Model-driven generation

Publishing an ordinary model must be sufficient to derive its standard CRUD/query/action contract surface from the Model Registry and Generic Runtime semantics.

The generator owns model-derived:

- Space model collection/item paths;
- request/response schemas;
- field constraints;
- relation identifiers;
- declared query/filter/sort parameters;
- lifecycle/version fields;
- model workflow actions;
- model scope/catalog metadata where published as contract artifacts.

Capabilities contribute their additional contract surface through registered deterministic generators; they do not patch OpenAPI ad hoc at runtime.

AI Admin never edits OpenAPI directly. It proposes Model Definitions; normal validation/publication then drives generation.

## Published artifacts

`packages/contracts` is the reproducible publication surface for versioned contract artifacts such as generated TypeScript types, JSON Schema/OpenAPI bundles and stable Markdown indexes. `packages/client` is the generated or thin handwritten SDK surface built against an explicit contract version.

Generated output must be reproducible from canonical inputs and must never become a second editable source of truth.

## Runtime versus build-time registry

Production Core resolves active Model Definitions from its Registry at runtime. Public contract publication is still an explicit versioned release action: the build/release process snapshots the intended published Registry/definition set and produces deterministic OpenAPI/JSON Schema/client artifacts.

Dynamic model administration therefore does not mean downstream applications silently consume an unversioned moving API contract.

## Downstream applications

ALOHA, HomeMew and vertical apps must depend on an explicit compatible contract/client version. They must not fetch an unversioned latest contract during normal builds.

For Coding Agents and repository-local development, an application may check in or generate a read-only contract snapshot containing the exact version it consumes. Such snapshots are generated artifacts and must not be edited manually.

## Compatibility

- Published Model Definition versions are immutable.
- Model changes require explicit compatibility classification: initial, compatible or breaking.
- Additive compatible changes may remain within the current API major version when semantics are preserved.
- Breaking request/response or behavior changes require an approved contract/version and downstream migration strategy.
- Model retirement is an explicit lifecycle action and does not silently delete historical definition versions.
- Core deployment and contract publication are coordinated, but applications release independently and may temporarily consume different compatible contract versions.
- Planned models/endpoints/fields must be clearly distinguishable from implemented/deployed ones before clients are allowed to call them.

## Required checks

Changes to public API behavior should fail CI when Kernel inputs, Model/Capability definitions, generated canonical contracts, implementation and published artifacts drift.

Required metadata-platform checks progressively include:

- Model Definition validation;
- deterministic schema hashing;
- deterministic OpenAPI/JSON Schema generation;
- no Kernel/model route collisions;
- no duplicate model-derived operation IDs/schema names;
- contract snapshot reproducibility;
- Generic Runtime behavior matching generated constraints.

HomeMew's former handwritten OpenAPI contract-check pattern remains a behavioral reference for strict drift detection, not the future source-authoring model.

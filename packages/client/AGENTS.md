# Client Package Agent Instructions

`packages/client` provides typed platform client/SDK helpers derived from explicit LifeSpace contracts.

## Rules

- Do not invent endpoints, fields or behavior not present in the canonical service contract.
- Keep authentication transport configurable so browser BFFs, Mini Programs, Agents and service backends can supply credentials appropriate to their environment.
- Do not embed application-specific UI logic, cookie policy or Space-selection policy in the shared client.
- Prefer generated request/response types from `packages/contracts` and thin, testable transport helpers.
- A client release must identify the contract version(s) it supports.
- Never hide authorization errors or silently retry non-idempotent writes.

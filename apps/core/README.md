# LifeSpace Core

Shared Cloudflare Worker business API for Space-owned life data.

## Planned stack

The initial implementation should reuse proven HomeMew patterns where still appropriate:

- Cloudflare Workers
- Hono
- D1
- Wrangler
- Vitest
- OpenAPI contract checks
- Node.js 24 / pnpm workspace

## Planned initial scope

The first implementation milestone is platform foundation rather than all future domains:

1. health/status conventions
2. authenticated principal plumbing
3. Space and membership
4. Data Grants
5. `/me` aggregate access conventions
6. event/task migration after the foundation is stable

Canonical API paths and schemas will live in `openapi.yaml` when implementation begins. Until then this README is planning context, not an implemented API contract.

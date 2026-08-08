# LifeSpace Architecture

## Purpose

LifeSpace is a shared platform for ALOHA, HomeMew, and future vertical applications. Applications present different product experiences over one identity and authorization model and one set of shared life-domain records.

## Runtime boundaries

```text
Web App browser
  -> same-origin App BFF
  -> Cloudflare Service Binding
  -> LifeSpace Core

Mini Program / Device / Agent / Automation
  -> scoped bearer credential
  -> LifeSpace Core

Applications / BFFs
  -> LifeSpace Identity for login, OAuth/SSO and token issuance
```

Initial platform services:

- `apps/core`: modular-monolith business API. Owns Spaces, Data Grants, shared domain models, business authorization, aggregate `/me` views, business migrations and webhooks/notifications that belong to domains.
- `apps/identity`: global authentication and credential service. Owns external identity mapping, application registration, login/SSO, sessions, authorization-code flows, token issuance and revocation.

## Data ownership

Every business record belongs to exactly one source Space. A Space may represent a personal, family, team, or future approved context. `space.kind` may drive defaults and product presentation but must not fork the underlying domain model without a real domain reason.

Cross-Space sharing uses Data Grants or approved derived views. Sharing does not copy or move the source record.

## Applications

ALOHA, HomeMew and vertical applications are clients, not data owners. App repositories own UI, app-specific navigation, local presentation state and optional BFF aggregation. They must not become parallel sources of truth for platform business data.

## Cloudflare deployment

Target production topology:

- `auth.aisr.online` -> Identity Worker
- `core.aisr.online` -> Core Worker
- application domains -> their own application Worker/Pages deployment and optional same-origin BFF

Production and staging use separate Workers and separate D1/R2/Queue resources.

## Core evolution from HomeMew

HomeMew Core is the reference implementation for proven patterns such as Hono on Workers, D1 migrations, standard response envelopes, request IDs, optimistic concurrency, soft deletion, OpenAPI checks, Queue usage and build/test discipline. Migration into LifeSpace must generalize `family` ownership into Space/Grant semantics rather than copying family-specific authorization mechanically.

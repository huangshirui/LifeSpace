# LifeSpace Architecture

## Purpose

LifeSpace is a shared platform for ALOHA, HomeMew, and future vertical applications. Applications present different product experiences over one LifeSpace user identity and authorization model and one set of shared life-domain records.

## Runtime boundaries

```text
Web App browser
  -> same-origin App BFF
  -> Cloudflare Service Binding
  -> LifeSpace Core

Mini Program / untrusted client
  -> short-lived app-scoped bearer token
  -> LifeSpace Core

Owner-controlled n8n / script / MCP / backend
  -> opaque Service API Token
  -> LifeSpace Core

Third-party or policy-controlled service
  -> OAuth client_credentials
  -> short-lived bearer token
  -> LifeSpace Core

Application-specific external login
  -> application adapter/BFF resolves external identity
  -> LifeSpace user_id
  -> authenticated backend token exchange with LifeSpace Identity
```

Initial platform services:

- `apps/core`: modular-monolith business API. Owns Spaces, Data Grants, shared domain models, business authorization, aggregate `/me` views, business migrations and webhooks/notifications that belong to domains.
- `apps/identity`: global LifeSpace user registry and credential issuer. Owns `usr_*` users, trusted application registration/credentials, service principals, opaque Service API Token lifecycle, short-lived token issuance/revocation and signing-key lifecycle. Platform SSO/session flows may be added later as explicit platform capabilities.

## Identity boundary

LifeSpace Identity is authoritative for the LifeSpace `user_id`, not for every external provider account used by every application.

Application-owned mappings stay in the application boundary:

```text
HomeMew WeChat Cloud Function
  openid -> LifeSpace user_id

School Mini Program adapter
  its WeChat/provider identity -> LifeSpace user_id

Other vertical app adapter
  provider-specific identity -> LifeSpace user_id
```

Core never stores or authenticates WeChat `openid`, WeCom `userid`, or equivalent external application IDs.

A trusted application backend authenticates to Identity with its own revocable application credential and may then:

- create a LifeSpace user when its own external mapping has no user yet;
- assert an existing LifeSpace `user_id` after resolving its own mapping;
- exchange that assertion for a short-lived Core token whose `azp` is derived from the authenticated application and whose scopes cannot exceed that application's registered scope ceiling.

Browser or Mini Program clients must never be allowed to submit an arbitrary `user_id` directly to token issuance endpoints.

Example HomeMew flow:

```text
Mini Program
  -> HomeMew login Cloud Function obtains trusted openid
  -> HomeMew mapping DB resolves openid -> usr_xxx
     or trusted HomeMew backend creates usr_xxx through Identity and stores the mapping
  -> HomeMew backend authenticates with its application credential
  -> Identity issues short-lived token: sub=usr_xxx, azp=homemew-miniprogram
  -> Mini Program calls LifeSpace Core with the token
```

This preserves the proven HomeMew boundary while removing the old shared-HS256-secret model.

## Service and automation authentication

**Implemented and verified in staging on 2026-08-11.** The normative credential and authorization rules are in `docs/service-authentication.md`.

LifeSpace supports two service modes:

- owner-controlled trusted backends such as self-hosted n8n, private scripts, cron jobs, and MCP servers may call Core directly with an opaque, revocable `lsp_pat_*` Service API Token;
- third-party or policy-controlled services may use OAuth `client_credentials` to obtain short-lived access tokens.

Both modes authenticate a service principal and pass through the same application-scope, current Data Grant, and domain authorization checks. Browser and Mini Program clients must not receive Service API Tokens.

Identity owns service principals and token hashes. Core recognizes an opaque token and uses an internal Identity Service Binding introspection call, then evaluates current Core authorization. The client still makes one Core HTTP request; it does not need a token-acquisition request. Core does not read Identity D1 directly or duplicate credential hashes.

## Data ownership

Every business record belongs to exactly one source Space. A Space may represent a personal, family, team, or future approved context. `space.kind` may drive defaults and product presentation but must not fork the underlying domain model without a real domain reason.

Cross-Space sharing uses Data Grants or approved derived views. Sharing does not copy or move the source record.

## Applications

ALOHA, HomeMew and vertical applications are clients, not data owners. App repositories own UI, app-specific navigation, local presentation state, external-provider identity mapping, provider secrets and optional BFF aggregation. They must not become parallel sources of truth for platform business data.

## Cloudflare deployment

Target production topology:

- `auth.aisr.online` -> Identity Worker
- `core.aisr.online` -> Core Worker
- application domains -> their own application Worker/Pages deployment and optional same-origin BFF

Production and staging use separate Workers and separate D1/R2/Queue resources.

## Core evolution from HomeMew

HomeMew Core is the reference implementation for proven patterns such as Hono on Workers, D1 migrations, standard response envelopes, request IDs, optimistic concurrency, soft deletion, OpenAPI checks, Queue usage and build/test discipline. Migration into LifeSpace must generalize `family` ownership into Space/Grant semantics rather than copying family-specific authorization mechanically.

HomeMew's existing identity implementation is also the reference for the external-identity boundary: WeChat Cloud Functions own `openid -> internal user ID` mapping, while Core accepts only the internal user ID carried by a verified token. LifeSpace keeps that boundary and centralizes only the LifeSpace user registry and token issuer.

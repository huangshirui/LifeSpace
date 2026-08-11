# LifeSpace Permission Model

## Core concepts

- **User**: global human identity authenticated by LifeSpace Identity.
- **Principal**: authenticated actor such as user, delegated Agent, service, device, or application backend.
- **Space**: source ownership and default authorization boundary for business data.
- **Space membership**: role-based relationship between a user and a Space.
- **Data Grant**: permission that exposes a Space, resource collection, approved view, or individual resource to another principal or Space without changing ownership.
- **Application scope**: permission granted to the calling application/client.
- **Service API Token**: long-lived opaque bearer credential for one trusted service principal and client context; it is individually scoped, optionally expiring, and revocable.

Do not use `Data Grant` to mean OAuth authorization code/grant flow.

## Effective permission

Effective permission is the intersection of:

1. verified principal identity,
2. current Space membership / Data Grant authorization,
3. the credential's scope constrained by the calling application's/client's allowed scope,
4. domain-specific restrictions.

No application is trusted merely because of its hostname or product name.

## Service credentials

**Implemented and verified in staging on 2026-08-11.** See `docs/service-authentication.md` for the normative credential lifecycle and implementation details.

A service may authenticate either with an opaque `lsp_pat_*` Service API Token or with a short-lived service JWT obtained through OAuth `client_credentials`. OAuth is optional for owner-controlled trusted services.

The credential authenticates a service principal; it does not itself confer Space membership or broad data access. Core intersects current token/client scopes with current Grants and domain rules on every request. Revoking a Token, disabling its principal, reducing its scopes, or revoking a Data Grant removes the corresponding authority on subsequent requests.

Service API Tokens may have `expires_at = null`, but they remain individually revocable and must never be issued to browsers, Mini Programs, downloadable clients, or permanent personal-user identities.

## Space roles

Initial role vocabulary should remain small: `owner`, `admin`, `editor`, `viewer`. Domain-specific or sensitive-data restrictions may further reduce these defaults. Roles are not a substitute for domain checks.

Personal Spaces may apply stricter lifecycle rules than family/team Spaces, such as one immutable owner and no ownership transfer, but such rules must be explicit policy rather than client assumptions.

## Data Grant principles

- Source data keeps exactly one `space_id`.
- Sharing must not duplicate the authoritative record.
- Grants may target a user/principal or another Space when approved.
- Grant resource scope may evolve from collection-level to record/view-level where a concrete requirement exists.
- Permission levels should be explicit. Calendar sharing may need `free_busy` in addition to `read`, `write`, and `manage`.
- Revocation must take effect from current Core authorization state; do not encode long-lived mutable Space permissions solely into JWT claims.

## Aggregate access

Authenticated aggregate endpoints such as `/api/v1/me/events` may return records from multiple source Spaces that the user can currently access. Each result must preserve source ownership and the caller's effective capabilities so clients can render read-only/shared data correctly.

## Actor safety

- Current actor is derived from verified credentials, never request `userId`.
- User-initiated Agent operations preserve delegated user context.
- Service and device identities receive only explicit scopes and Grants.
- A Service API Token authenticates a service principal and never becomes an implicit Space membership or administrator role.
- A system identity does not become a Space member merely to gain API access.

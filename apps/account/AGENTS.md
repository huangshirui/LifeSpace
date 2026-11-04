# LifeSpace Account Agent Instructions

Account is the **user-facing experience** for LifeSpace OAuth Consent and later connections/authorization aggregation. It does not own User identity, OAuth Authorization, Space permissions, Delegations or application model rights.

Before editing, read root `AGENTS.md`, `apps/AGENTS.md`, `docs/architecture.md`, `docs/permissions.md`, `docs/application-authentication.md`, `docs/service-authentication.md`, `docs/contracts.md`, `docs/identity-oauth.md`, and relevant Core/Identity OAuth OpenAPI contracts.

- Account is separate from the Platform Admin Console. It **must never** use Platform Admin actor proof, bootstrap credentials or global Service grants.
- Cloudflare Access provides same-origin SSO; the BFF passes the original Access assertion to Identity over the registered Account `lsa_*` credential and receives a short-lived Account-app-scoped LifeSpace user token.
- Keep Access JWT, user bearer tokens, `lsa_*`, and Core/Identity service secrets strictly server-side. Never copy them into browser JS, URLs, client-local storage or logs.
- All browser API calls stay same-origin. Validate method, request shape, IDs, Origin, Fetch Metadata and CSRF for every mutation. A rendered confirmation is not backend authorization.
- Only show user-accessible Space and bounded Agent/Application candidates from Core/Identity. Identity must re-validate on confirmation; Core is the authoritative Space/Grant gate.
- Display requested OAuth Scope separately from effective Core operations, and never invent capability projections. `allowUserAuthorization` is permission to **apply** for Delegation, not pre-approved `dlg_*`.
- Never create or persist a generic `conn_*` connection or independent Account authorization database.
- The Account consent route may return the validated OAuth callback to the browser only after the user explicitly confirms the exact selection. Referrer policy is no-referrer.
- Keep Staging and Production environment bindings isolated. Deployment requires reviewed Access audience, Account Application credentials and security approval.

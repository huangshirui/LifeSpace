# LifeSpace Console Agent Instructions

`apps/console` is the LifeSpace platform operations/governance Web application for `lifespace.aisr.online`. It is a client/BFF over Identity and Core and must never become a third source of truth for platform state.

## Before changing Console

Read:

1. root `AGENTS.md`;
2. `apps/AGENTS.md`;
3. `docs/architecture.md`;
4. `docs/permissions.md`;
5. `docs/application-authentication.md`;
6. `docs/service-authentication.md`;
7. `docs/contracts.md`;
8. `docs/lifespace-console-mvp.md`;
9. Identity/Core Platform Admin companion contracts.

## Responsibilities

Console owns:

- platform-operator Web UI and navigation;
- same-origin BFF endpoints used by that UI;
- Cloudflare Worker/static-assets deployment for the Console hostname;
- server-side orchestration of Access -> LifeSpace user exchange -> short-lived actor proof -> Identity/Core platform-admin calls;
- presentation/aggregation of Identity/Core control-plane responses.

Console does not own:

- global users, Access principal mappings or platform-administrator assignments;
- Spaces, members, Grants or model records;
- Applications, Service Principals, Model Registry or Application × Model Access as persistence;
- an independent audit database;
- Cloudflare Access identity verification as a replacement for Identity;
- bootstrap authority in normal runtime.

## Authentication and secrets

- Cloudflare Access protects the Console hostname, but Access entry alone is not LifeSpace platform-admin authority.
- For LifeSpace-dependent requests, read the original `Cf-Access-Jwt-Assertion` request header server-side and forward the raw assertion to Identity's approved exchange. Never trust browser-supplied decoded `sub`, email, audience or `userId`.
- Do not parse an Access token in browser JavaScript to infer LifeSpace identity/authority.
- Browser JavaScript must never receive `lsa_*`, `lsp_pat_*`, bootstrap secrets, OAuth client secrets or platform-admin actor JWTs.
- The BFF may obtain the <=5-minute `purpose=platform_admin_actor` proof but keeps it server-side and uses it only for the current privileged operation.
- Identity control-plane calls use the Console `lsa_*` executor plus actor proof.
- Core control-plane calls use the dedicated Console service executor plus actor proof.
- Actor and executor application context must match; Console code must not attempt to bypass this rule.
- The bootstrap secret is never a Console Worker secret.

## BFF rules

- Expose bounded purpose-specific endpoints, not an arbitrary Identity/Core reverse proxy or Swagger executor.
- Never accept a client-controlled upstream URL/path/Authorization header.
- Return only the fields the UI needs; avoid relaying credential material or unnecessarily broad platform datasets.
- Read-only inspector endpoints stay read-only.
- Before adding cookie-backed or other browser mutations, enforce exact Origin/CSRF protections documented in platform architecture.
- Transport may use Cloudflare Service Bindings, but explicit LifeSpace credentials remain the authorization boundary.
- Service Binding use must not create cross-app database coupling.

## Proving shell

Before the full React/Vite MVP, a minimal static-assets + Worker proving shell may exist to establish the real staging hostname/Access/BFF/Identity/Core chain.

The proving shell is deliberately constrained:

- no business-data mutation;
- no model publication/retirement;
- no credential-management UI;
- no arbitrary API proxy;
- no browser-visible LifeSpace or Access bearer tokens;
- session identity and read-only control-plane probe remain the normal surfaces;
- while staging proving is incomplete, the shell may additionally expose one bounded first-use Identity onboarding mutation that explicitly creates the **current verified Access principal's new staging LifeSpace user** through Identity's canonical `/internal/v1/access/registrations` flow;
- that staging registration must require an exact same-origin browser request plus an explicit user confirmation, must never accept a target `usr_*`, email/sub mapping override or backend credential, and must be unavailable in production;
- existing-account linking remains proof-backed through Identity link challenges and must never be replaced by a Console `userId` picker or email match.

The Worker/BFF implementation and deployment boundary are intended to remain when React/Vite replaces the temporary static presentation layer. Do not put business/security logic into the proving-page JavaScript.

## Frontend direction

The final MVP frontend is React + TypeScript + Vite on Cloudflare Workers/Static Assets. Introduce that dependency set in the dedicated UI slice after the proving shell/staging Access path is accepted, rather than expanding the control-plane foundation PR with an unrelated dependency migration.

## Environment isolation

- Staging: `lifespace-staging.aisr.online` / `lifespace-console-staging` with staging Identity/Core and staging credentials.
- Production: `lifespace.aisr.online` / `lifespace-console` with production Identity/Core and independent production credentials.
- Never point staging Console bindings/secrets at production services or vice versa.
- Do not deploy production from a staging proving change.

## Verification

A Console change is incomplete until:

- typecheck and Wrangler dry-run build pass;
- proving-page JavaScript syntax is checked;
- static/API route behavior is deterministic;
- missing Access assertion fails safely;
- unlinked Access principal is surfaced explicitly and never auto-created/email-merged;
- any staging first-use registration is explicit, exact-origin protected, Identity-owned, target-user-id-free and unavailable in production;
- non-admin actor is denied;
- Identity/Core executors and actor proof remain server-only;
- staging/prod configuration is isolated;
- no purpose-specific BFF endpoint broadens into an arbitrary proxy.

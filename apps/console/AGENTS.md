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
- Browser JavaScript must never receive `lsa_*`, `lsp_pat_*`, bootstrap secrets, OAuth client secrets, LifeSpace user bearer tokens, raw Access JWTs or platform-admin actor JWTs.
- The BFF may obtain the <=5-minute `purpose=platform_admin_actor` proof but keeps it server-side and uses it only for the current privileged operation.
- Identity control-plane calls use the Console `lsa_*` executor plus actor proof.
- Core control-plane calls use the dedicated Console service executor plus actor proof.
- Actor and executor application context must match; Console code must not attempt to bypass this rule.
- The bootstrap secret is never a Console Worker secret.

## BFF rules

- Expose bounded purpose-specific endpoints, not an arbitrary Identity/Core reverse proxy or Swagger executor.
- Never accept a client-controlled upstream URL/path/Authorization header.
- Validate path identifiers, query names, query multiplicity and result limits before forming upstream requests.
- Return only the fields the UI needs; avoid relaying credential material or unnecessarily broad platform datasets.
- Read-only inspector endpoints stay read-only.
- Before adding cookie-backed or other browser mutations, enforce exact Origin/CSRF protections documented in platform architecture.
- Transport may use Cloudflare Service Bindings, but explicit LifeSpace credentials remain the authorization boundary.
- Service Binding use must not create cross-app database coupling.

## Current React/Vite MVP

The permanent Console presentation shell is React + TypeScript + Vite with the Cloudflare Vite plugin. The earlier `public/` proving page was staging bootstrap evidence and is no longer the implementation target.

The current read-only MVP surfaces are:

- Overview;
- Applications and application diagnostic detail;
- Models and published-model detail;
- Users and linked Access-principal diagnostics;
- Spaces with memberships, Grants and record counts;
- combined Identity/Core platform audit;
- System status/security-boundary diagnostics.

The browser calls only same-origin `/api/*` endpoints. The Worker resolves every privileged request through Access -> Identity user session -> dedicated actor proof -> fixed Identity/Core control-plane operation. Do not move that orchestration into React.

The only browser mutation retained in this read-only slice is the staging-only first-use registration for the **current verified Access principal**. It must:

- use Identity's canonical `/internal/v1/access/registrations` flow;
- require exact same-origin browser context, explicit intent and explicit user confirmation;
- never accept a target `usr_*`, email/sub mapping override or backend credential;
- be unavailable in production;
- never replace proof-backed existing-account linking or email auto-merge rules.

## Cloudflare Vite deployment

- `vite build` owns the built client asset directory and generated Worker deployment configuration.
- Do not restore `assets.directory: ./public` or deploy the obsolete proving shell as the primary frontend.
- Select staging/production at **build time** with `CLOUDFLARE_ENV` so the generated deployment configuration contains the intended Worker name, routes, variables and service bindings.
- After a Vite-plugin build, deploy through the generated configuration; do not rely on a later `wrangler deploy --env ...` to switch environment.
- Keep Console-only frontend/tooling upgrades scoped to `apps/console` unless platform-wide alignment is separately justified.

## Environment isolation

- Staging: `lifespace-staging.aisr.online` / `lifespace-console-staging` with staging Identity/Core and staging credentials.
- Production: `lifespace.aisr.online` / `lifespace-console` with production Identity/Core and independent production credentials.
- Never point staging Console bindings/secrets at production services or vice versa.
- Do not deploy production from a staging change without explicit approval.

## Verification

A Console change is incomplete until:

- workspace install succeeds with the committed frozen lockfile;
- React/Worker TypeScript typecheck and Vite build pass;
- built client/static-asset and `/api/*` Worker routing remain deterministic;
- missing Access assertion fails safely;
- unlinked Access principal is surfaced explicitly and never auto-created/email-merged;
- any staging first-use registration is explicit, exact-origin protected, Identity-owned, target-user-id-free and unavailable in production;
- non-admin actor is denied;
- Identity/Core executors, LifeSpace user bearer and actor proof remain server-only;
- path/query bounds prevent a purpose-specific BFF endpoint from becoming an arbitrary proxy;
- staging/prod Vite build/deployment configuration is isolated;
- real staging browser verification covers the intended read-only Console pages before the slice is Ready.

# LifeSpace Console Agent Instructions

`apps/console` is the LifeSpace platform operations/governance and configuration Web application for `lifespace.aisr.online`. It is a client/BFF over Identity and Core and must never become a third source of truth for platform state.

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
9. the current Console configuration/publishing design notes in this repository;
10. Identity/Core Platform Admin companion contracts and the canonical Model Admin contract before adding a mutation.

## Responsibilities

Console owns:

- platform-operator Web UI and navigation;
- same-origin bounded BFF endpoints used by that UI;
- Cloudflare Worker/static-assets deployment for the Console hostname;
- server-side orchestration of Access -> LifeSpace user exchange -> short-lived actor proof -> Identity/Core platform-admin calls;
- presentation/aggregation of Identity/Core control-plane responses;
- explicit operator workflows for approved platform configuration and publication actions.

Console does not own:

- global users, Access principal mappings or platform-administrator assignments;
- Spaces, members, Grants or model records as persistence;
- Applications, Service Principals, Model Registry or Application × Model Access as persistence;
- an independent model schema, policy language, contract generator or audit database;
- Cloudflare Access identity verification as a replacement for Identity;
- bootstrap authority in normal runtime;
- application-specific family/tenant administration merely because the platform can inspect a Space.

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
- Validate path identifiers, query names, query multiplicity, request shape/body size and result limits before forming upstream requests.
- Return only the fields the UI needs; avoid relaying credential material or unnecessarily broad platform datasets.
- Read-only inspector endpoints stay read-only unless a separately specified control-plane mutation is intentionally introduced.
- Every browser mutation must enforce exact Origin/Fetch-Metadata protections, JSON request shape, an operation-specific explicit intent and any destructive confirmation required by that operation.
- A React confirmation dialog is UX only. Security-critical confirmation must also be represented in and validated by the BFF request when applicable.
- Transport may use Cloudflare Service Bindings, but explicit LifeSpace credentials remain the authorization boundary.
- Service Binding use must not create cross-app database coupling.

## Current React/Vite control plane

The permanent Console presentation shell is React + TypeScript + Vite with the Cloudflare Vite plugin. The earlier `public/` proving page was staging bootstrap evidence and is no longer the implementation target.

The established read/inspection surfaces are:

- Overview;
- Applications and application diagnostic detail;
- Models and published-model detail;
- Users and linked Access-principal diagnostics;
- Spaces with memberships, Grants and record counts;
- combined Identity/Core platform audit;
- System status/security-boundary diagnostics.

The first configuration/publishing write slice adds only these bounded capabilities on top of the existing authoritative control planes:

- validate a canonical Model Definition through Core Model Admin;
- publish a Model Definition with explicit compatibility classification;
- retire a published model through Core Model Admin;
- atomically replace one application's Application × Model Access catalog.

These actions must not add new Core/Identity persistence or duplicate platform state in Console. Model publication remains Registry-driven and generates the canonical Model Contract Revision in Core; Application × Model Access remains Core-owned authorization policy.

The browser calls only same-origin `/api/*` endpoints. The Worker resolves every privileged request through Access -> Identity user session -> dedicated actor proof -> fixed Identity/Core control-plane operation. Do not move that orchestration into React.

A visual field/capability model designer may be added later, but it must only author the same canonical Model Definition consumed by Core's closed validator. It must never introduce a second model-definition format or direct DDL/SQL/JavaScript publication path.

## First-use Access registration

The staging-only first-use registration for the **current verified Access principal** remains a special bounded mutation. It must:

- use Identity's canonical `/internal/v1/access/registrations` flow;
- require exact same-origin browser context, explicit intent and explicit user confirmation;
- never accept a target `usr_*`, email/sub mapping override or backend credential;
- be unavailable in production;
- never replace proof-backed existing-account linking or email auto-merge rules.

## Platform vs application administration boundary

LifeSpace Console configures platform-wide metadata and platform authorization ceilings. It is not the product administration UI for HomeMew, ALOHA or another vertical application.

In particular:

- Application × Model Access belongs in Console because it is platform application policy;
- service principal/credential governance may be added as a bounded Console control-plane capability when explicitly implemented;
- Space-specific Data Grants, family membership policy, webhook destinations and other tenant/product configuration should remain in the owning application administration surface unless a separate platform-governance use case is approved;
- Console inspection of a Space never grants hidden membership or business-data editing authority.

## Parallel-work isolation

Console work should be easy to develop, deploy to staging and merge independently from Core/Identity feature branches.

- Prefer consuming already-merged contracts before adding new downstream APIs.
- If a required Core/Identity capability is missing, add the smallest separately reviewable contract/runtime change rather than coupling unrelated refactors into a Console branch.
- Do not base Console UI work on an unrelated in-flight feature branch unless the dependency is intentional and documented.
- Avoid touching Runtime Discovery, Eventing, HomeMew migration/application code or other active slices merely to implement Console presentation.
- **Normal Console-only staging changes use `.github/workflows/lifespace-console-staging-deploy.yml`.** Its default deploy job must remain manual-only and must not migrate/deploy Core or Identity, use bootstrap authority, rotate/install secrets, or target production.
- The same workflow exposes an explicit `run_control_plane_acceptance` opt-in. Only that separate acceptance job may use staging bootstrap authority to exercise and clean up the bounded control-plane write lifecycles; it must not deploy/migrate Core, Identity or Console.
- `.github/workflows/lifespace-console-staging-provision.yml` is a platform/credential convergence workflow, not the default Console deploy path. Use it only when Core/Identity/platform-admin/application credential convergence is intentionally part of the task.
- Never use a feature branch's full provisioning workflow merely to deploy Console if doing so could roll shared staging Core/Identity backward or overwrite another in-flight platform slice.
- Keep `scripts/check-staging-deploy-isolation.mjs` and `scripts/check-control-plane-boundary.mjs` green; weakening or bypassing these guards requires an explicit architecture decision, not a convenience edit.
- When temporary duplication in the BFF meaningfully reduces merge conflict, document it and schedule consolidation only after the parallel conflict window closes; do not weaken security invariants for convenience.

## Cloudflare Vite deployment

- `vite build` owns the built client asset directory and generated Worker deployment configuration.
- Do not restore `assets.directory: ./public` or deploy the obsolete proving shell as the primary frontend.
- Select staging/production at **build time** with `CLOUDFLARE_ENV` so the generated deployment configuration contains the intended Worker name, routes, variables and service bindings.
- After a Vite-plugin build, deploy through the generated configuration; do not rely on a later `wrangler deploy --env ...` to switch environment.
- Ordinary Console-only staging deployment preserves the already-installed Worker secrets; do not pass `--secrets-file` or bootstrap credentials to that workflow.
- Keep Console-only frontend/tooling upgrades scoped to `apps/console` unless platform-wide alignment is separately justified.

## Environment isolation

- Staging: `lifespace-staging.aisr.online` / `lifespace-console-staging` with staging Identity/Core and staging credentials.
- Production: `lifespace.aisr.online` / `lifespace-console` with production Identity/Core and independent production credentials.
- Never point staging Console bindings/secrets at production services or vice versa.
- Do not deploy production from a staging change without explicit approval.
- A model/configuration mutation tested in staging is not permission to repeat it against production data.

## Verification

A Console change is incomplete until the relevant items below are proven:

- workspace install succeeds with the committed frozen lockfile;
- React/Worker TypeScript typecheck and Vite build pass;
- Console control-plane and staging-isolation guard scripts pass;
- built client/static-asset and `/api/*` Worker routing remain deterministic;
- missing Access assertion fails safely;
- unlinked Access principal is surfaced explicitly and never auto-created/email-merged;
- any staging first-use registration is explicit, exact-origin protected, Identity-owned, target-user-id-free and unavailable in production;
- non-admin actor is denied;
- Identity/Core executors, LifeSpace user bearer and actor proof remain server-only;
- path/query/body bounds prevent a purpose-specific BFF endpoint from becoming an arbitrary proxy;
- each mutation rejects missing/wrong Origin, Fetch Metadata, Content-Type and operation intent;
- destructive or whole-catalog replacement operations enforce their required confirmation server-side as well as in the UI;
- Model validate/publish/retire preserve Core validation, compatibility and human/executor audit semantics;
- Application × Model Access changes cannot exceed Core's published-model declared access capability and do not bypass normal credential/Data Grant checks;
- normal Console staging deployment reads current Core/Identity compatibility only and does not mutate/deploy those services;
- staging/prod Vite build/deployment configuration is isolated;
- real staging browser verification covers both established read pages and every newly added mutation before the write slice is Ready;
- production remains untouched unless production rollout was explicitly approved.

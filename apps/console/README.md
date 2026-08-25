# LifeSpace Console

LifeSpace Console is the LifeSpace platform operations, governance and configuration Web application for `lifespace.aisr.online`.

The permanent implementation is **React + TypeScript + Vite + Cloudflare Worker/BFF**. The browser never talks directly to Identity/Core administrative APIs and never receives platform executor credentials.

## Information architecture

```text
Overview
Platform
  Applications
  Models
  Users
  Spaces
Operations
  Audit
  System
```

The established pages remain the platform inspection surface. The current configuration/publishing slice adds bounded write workflows without making Console a separate source of truth.

## Configuration/publishing scope

Current write slice:

```text
Models
  Validate Model Definition
  Publish new model / new model version
  Retire model

Applications
  Replace Application × Model Access catalog
```

All four operations reuse authoritative Core control planes that already exist. This slice does **not** add Core/Identity migrations, handwritten ordinary-model CRUD, a second contract format, or direct DDL/SQL execution.

Model publication remains:

```text
canonical Model Definition
-> Core closed validator
-> explicit compatibility classification
-> Core publish
-> Registry + typed physical schema
-> immutable Model Contract Revision
```

A future visual model designer may improve authoring UX, but its output must still be the same canonical Model Definition.

Application × Model Access is only the application-level model permission ceiling. Effective runtime authorization still intersects credential scope, Application × Model Access, current Space membership/Data Grant, published-model capability and model policy/capability restrictions.

## Same-origin BFF routes

Established read/session routes:

```text
GET  /api/health
GET  /api/session
POST /api/session/register   # staging first-use only
GET  /api/platform/probe
GET  /api/overview
GET  /api/applications
GET  /api/applications/:applicationId
GET  /api/models
GET  /api/models/:modelKey
GET  /api/users
GET  /api/users/:userId
GET  /api/spaces
GET  /api/spaces/:spaceId
GET  /api/audit
GET  /api/system
```

Configuration/publishing routes:

```text
PUT  /api/applications/:applicationId/model-access
POST /api/models/validate
POST /api/models/publish
POST /api/models/:modelKey/retire
```

The browser supplies only bounded operation input. It never supplies an upstream URL, upstream path, Authorization header or platform credential.

## Privileged security chain

For every privileged operation the Worker performs:

```text
Cloudflare Access assertion
-> LifeSpace Identity Access exchange
-> app-scoped LifeSpace user credential
-> <=5-minute purpose=platform_admin_actor proof
-> controlled server-side executor
-> fixed Identity/Core control-plane operation
```

Identity control-plane calls use the Console `lsa_*` application credential plus actor proof. Core control-plane calls use the dedicated Console `lsp_pat_*` service executor plus actor proof. Actor and executor must belong to the same Console application context.

The following never cross the Worker/browser boundary:

- raw `Cf-Access-Jwt-Assertion`;
- LifeSpace user bearer;
- platform-admin actor JWT;
- `lsa_*` application credential;
- `lsp_pat_*` Core executor;
- bootstrap secret.

Browser mutations additionally require exact same-origin evidence, `Sec-Fetch-Site: same-origin`, JSON Content-Type and an operation-specific `x-lifespace-console-intent`. Destructive/whole-catalog operations must carry explicit confirmation that is validated by the BFF, not only by React UI state.

## First-use Access identity

A valid Cloudflare Access principal may still be unknown to LifeSpace Identity. Access email is diagnostic metadata, never merge authority.

`POST /api/session/register` remains staging-only and can create a new LifeSpace user only for the **current verified Access principal**. It cannot choose a target `usr_*`, email mapping, Access subject or backend credential. Existing-account linking continues to use the proof-backed Identity linking flow.

## Platform/application boundary

Console is the platform configuration center, not the HomeMew/ALOHA product administration UI.

Belongs in Console:

- Model Registry publication lifecycle;
- Application × Model Access;
- platform application / credential / service-principal governance when explicitly added as bounded control-plane workflows;
- platform inspection/audit/system diagnostics.

Normally remains in application administration surfaces:

- family/tenant-specific configuration;
- Space-specific Data Grants;
- business record editing;
- application webhook destinations/integration settings;
- product-specific member administration.

Inspecting a Space in Console never makes the platform administrator a hidden Space member.

## Runtime bindings and secrets

Committed non-secret vars:

```text
ENVIRONMENT
IDENTITY_BASE_URL
CORE_BASE_URL
```

Staging/production Service Bindings:

```text
IDENTITY -> matching Identity Worker
CORE     -> matching Core Worker
```

Worker secrets in full-admin mode:

```text
IDENTITY_APPLICATION_CREDENTIAL  # server-only lsa_*
CORE_EXECUTOR_BEARER             # dedicated lsp_pat_* executor
```

The global bootstrap secret is deliberately not a Console Worker secret.

## Cloudflare/Vite deployment

The Console uses `@cloudflare/vite-plugin`; Vite owns client asset output and generated Worker deployment configuration.

Select target environment at build time:

```text
CLOUDFLARE_ENV=staging pnpm exec vite build
pnpm exec wrangler deploy --secrets-file <ephemeral-secrets-file>
```

Production uses a separate build environment/configuration and requires explicit production rollout approval. Do not restore the historical `public/` proving shell as the deployment source.

Canonical staging workflow:

```text
.github/workflows/lifespace-console-staging-provision.yml
```

## Parallel development

Console work should remain mergeable independently from unrelated Core/Identity feature work. Prefer already-merged control-plane contracts and isolate UI/BFF changes inside `apps/console`.

The current write slice was intentionally started independently of the parallel Runtime Discovery work. It does not modify Runtime Discovery, Eventing, HomeMew, Core migrations or Identity migrations.

## Verification gate

Before this write slice is Ready:

1. `pnpm install --frozen-lockfile` and full `pnpm check` must actually execute and pass;
2. React/Worker TypeScript and Vite build must pass;
3. mutation BFF routes must reject wrong/missing Origin, Fetch Metadata, Content-Type, intent and required confirmation;
4. missing/unlinked/non-admin/wrong-application authority must fail safely;
5. browser source/network responses must contain no Access/LifeSpace/actor/executor bearer material;
6. Model validate/publish/retire must preserve Core validation, compatibility and human/executor audit semantics;
7. Application × Model Access replacement must remain inside published-model capability and normal runtime authorization intersections;
8. real staging browser verification must cover existing read pages plus every new write workflow;
9. staging and production bindings/credentials must remain isolated;
10. production must remain untouched until explicitly approved.

The accepted read-only foundation is documented in `docs/lifespace-console-mvp.md`; this configuration/publishing slice advances that foundation rather than replacing its security architecture.

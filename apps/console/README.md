# LifeSpace Console

LifeSpace Console is the LifeSpace platform operations, governance and configuration Web application for `lifespace.aisr.online`.

The permanent implementation is **React + TypeScript + Vite + Cloudflare Worker/BFF**. The browser never talks directly to Identity/Core administrative APIs and ordinary browser JavaScript never receives platform executor credentials.

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

The established pages remain the platform inspection surface. The Configuration & Publishing Center adds bounded write workflows without making Console a separate source of truth.

## Configuration & Publishing Center MVP

The first MVP is intentionally defined as **Slices A + B + C**:

```text
Models
  Validate canonical Model Definition
  Publish new model / model version
  Retire model

Applications
  Create Application
  Configure name / allowed scopes / token TTL / active-disabled state
  Register / revoke Cloudflare Access audience
  Replace Application × Model Access catalog

Credentials / external systems
  Create / revoke target Application credential
  Create / update / disable Service Principal
  Create / reduce / update / revoke Service API Token
```

All operations reuse authoritative Core/Identity control planes. Console does **not** add an independent model schema, credential database, Core/Identity migrations, handwritten ordinary-model CRUD, direct DDL/SQL execution or hidden Space impersonation.

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

Configuration/publishing routes include the bounded model/Application operations plus purpose-specific credential/service routes under `/api/credential-governance/applications/:applicationId/...` and the isolated target-credential reveal route `/api/credential-reveal?ticket=...`.

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

The following never cross the normal Worker/browser JavaScript boundary:

- raw `Cf-Access-Jwt-Assertion`;
- LifeSpace user bearer;
- platform-admin actor JWT;
- Console `lsa_*` application credential;
- Console `lsp_pat_*` Core executor;
- bootstrap secret.

Newly issued **target** Application credentials and Service API Tokens use the separately documented operator reveal boundary in `docs/console-target-credential-reveal.md`: plaintext exists only server-side until a current platform administrator opens a short-lived AES-GCM-sealed reveal URL. The reveal response is no-script/no-store. No plaintext target secret is placed in React JSON, cookies, storage, query parameters, logs or audit.

Browser mutations additionally require exact same-origin evidence, `Sec-Fetch-Site: same-origin`, JSON Content-Type and an operation-specific `x-lifespace-console-intent`. Destructive/whole-catalog operations must carry explicit confirmation that is validated by the BFF, not only by React UI state.

## First-use Access identity

A valid Cloudflare Access principal may still be unknown to LifeSpace Identity. Access email is diagnostic metadata, never merge authority.

`POST /api/session/register` remains staging-only and can create a new LifeSpace user only for the **current verified Access principal**. It cannot choose a target `usr_*`, email mapping, Access subject or backend credential. Existing-account linking continues to use the proof-backed Identity linking flow.

## Platform/application boundary

Console is the platform configuration center, not the HomeMew/ALOHA product administration UI.

Belongs in Console:

- Model Registry publication lifecycle;
- Application policy and Application × Model Access;
- platform Application credential / Service Principal / Service API Token governance;
- Access audience registration/revocation;
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
IDENTITY_APPLICATION_CREDENTIAL  # server-only Console lsa_*
CORE_EXECUTOR_BEARER             # dedicated Console lsp_pat_* executor
```

The global bootstrap secret is deliberately not a Console Worker secret.

## Cloudflare/Vite deployment

The Console uses `@cloudflare/vite-plugin`; Vite owns client asset output and generated Worker deployment configuration. Select the target environment at **build time** and deploy the generated configuration.

There are deliberately two different staging workflows with different authority boundaries.

### Ordinary Console code/UI deployment

Canonical workflow:

```text
.github/workflows/lifespace-console-staging-deploy.yml
```

This is the default for normal Console-only changes. It is manual-only and must remain isolated:

```text
Console frozen install/check
-> read current staging Identity/Core status only
-> CLOUDFLARE_ENV=staging Vite build
-> deploy lifespace-console-staging using existing Worker secrets
-> verify lifespace-staging.aisr.online is reachable behind Access
```

It must **not** run D1 migrations, deploy Core/Identity, use the bootstrap secret, rotate/install secrets, or target production. This lets Console staging move independently while other LifeSpace branches are changing Core/Identity.

`@lifespace/console check` includes built-Worker `node --check`, in addition to TypeScript/Vite and control-plane boundary guards, because staging deployment proved that TypeScript/Vite alone can miss a Worker-runtime JavaScript parser incompatibility.

### Real staging transaction acceptance

Canonical workflow:

```text
.github/workflows/lifespace-console-staging-acceptance.yml
```

It is manual-only, staging-only and performs no deployments/migrations. It exercises and cleans up the real A+B+C platform transactions:

```text
Model validate/publish/version/retire + Model Access restore
Application create/update + Access Audience lifecycle
Application credential rotation
Service Principal lifecycle
Service API Token create/reduce/re-expansion-deny/revoke
platform-admin audit / plaintext-leak checks
```

The generated Slice B/C acceptance Application is disabled at cleanup because the canonical platform contract currently has no delete-Application lifecycle.

### Platform/credential convergence

Canonical workflow:

```text
.github/workflows/lifespace-console-staging-provision.yml
```

Use this only when staging platform convergence itself is intended: migrations/platform service deployment, Console application/AUD reconciliation, platform-administrator assignment, executor credential rotation or first-use provisioning. Because it can mutate/deploy Core and Identity, it must not be used merely to publish a Console feature branch while unrelated platform work is in flight.

Production uses independent configuration/credentials and requires explicit production rollout approval.

## Current staging evidence

The complete B+C Console is deployed on `lifespace-staging.aisr.online` behind Cloudflare Access.

Current proving evidence:

- staging Identity schema `7`, contract `0.5.0`;
- staging Core schema `28`, contract `0.15.0`;
- Console Worker version `bdd0634d-5a7c-433a-a8f1-cae792634e3d`;
- real Slice B/C lifecycle acceptance run `32926401047` succeeded;
- 13 human-attributed Identity platform-admin audit rows were observed for the disposable lifecycle;
- generated target secrets were absent from metadata/audit checks;
- authenticated Cloudflare Access browser smoke for the write workflows was completed by the platform operator on 2026-08-26;
- production was not targeted.

The automated transaction acceptance and authenticated browser smoke are deliberately separate evidence. Together they satisfy the write-slice staging acceptance required by `apps/console/AGENTS.md`.

## Parallel development

Console work should remain mergeable and deployable independently from unrelated Core/Identity feature work. Prefer already-merged control-plane contracts and isolate UI/BFF changes inside `apps/console`.

The current Configuration Center work was intentionally developed independently of Runtime Discovery. It does not modify Runtime Discovery, Eventing, HomeMew, Core migrations or Identity migrations.

## Verification gate

The write-slice gate requires all of the following; the Configuration & Publishing Center MVP satisfied them in staging on 2026-08-26:

1. frozen workspace install and full `pnpm check` must actually execute and pass;
2. React/Worker TypeScript, Vite build and built-Worker `node --check` must pass;
3. mutation BFF routes must reject wrong/missing Origin, Fetch Metadata, Content-Type, intent and required confirmation;
4. missing/unlinked/non-admin/wrong-application authority must fail safely;
5. ordinary browser JavaScript/network JSON must contain no Access/LifeSpace/actor/executor bearer material or target credential plaintext;
6. Model validate/publish/retire must preserve Core validation, compatibility and human/executor audit semantics;
7. Application × Model Access replacement must remain inside published-model capability and normal runtime authorization intersections;
8. Application/Audience/Credential/Service Principal/Service API Token lifecycle must preserve Identity scope ceilings and audit semantics;
9. isolated staging deployment must not mutate/deploy Core/Identity or require bootstrap authority;
10. real staging transaction acceptance must prove the A+B+C lifecycle and cleanup;
11. real authenticated Cloudflare Access browser smoke must cover established read pages and every newly added mutation;
12. staging and production bindings/credentials must remain isolated;
13. production remains untouched until explicitly approved.

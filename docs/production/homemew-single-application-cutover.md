# HomeMew single-LifeSpace-Application production cutover

Date: 2026-10-08
Status: Planned / not executed

## Goal

Consolidate the three legacy HomeMew LifeSpace Application registrations into one canonical HomeMew Application without teaching LifeSpace about HomeMew client/deployment topology.

Legacy production registrations:

- `homemew-miniprogram` — legacy Mini/provider-backed HomeMew Application;
- `app_homemew_web_production` — legacy Web Application;
- `app_homemew_integrations_production` — legacy synthetic integrations Application.

Target:

```text
LifeSpace Application: HomeMew
  ├─ one or more active lsa_* trusted-backend credentials
  ├─ homemew.aisr.online Cloudflare Access audience
  ├─ HomeMew Application × Model Access
  ├─ HomeMew-managed Service Principals / external systems
  └─ HomeMew-managed Agents
```

Mini Program, Web/PWA, BFFs, Workers, provider adapters and integration orchestration remain HomeMew implementation details and are not LifeSpace Applications.

## Hard gates

Do not execute the production cutover until all of the following are true:

1. LifeSpace Identity `0.11.0` / schema `>=10` is deployed to production and the Application representation no longer contains `clientType`.
2. HomeMew single-Application consumer changes are merged but not yet deployed.
3. HomeMew Web/backend no longer require retired `creation-drafts:*` scopes. The canonical Application must not reintroduce those scopes.
4. Current production state of all three legacy Applications has been read from LifeSpace Console and recorded in the execution notes: status, allowed scopes, access-token TTL, active credential count/suffix metadata, Access audiences and Application × Model Access.
5. Existing HomeMew external systems have been inventoried and the operator accepts that they will be disabled/revoked and recreated after cutover rather than migrated across Application ownership.
6. No unrelated LifeSpace staging/production deployment is running during the cutover.

## Canonical Application policy

Create a new neutral Application through LifeSpace Console. Let LifeSpace generate a normal opaque `app_*` identifier; do not reuse `homemew-miniprogram`, `app_homemew_web_production` or `app_homemew_integrations_production`.

Name:

```text
HomeMew
```

Trusted backend:

```text
true
```

Canonical allowed-scope ceiling, subject to final source-code/preflight verification immediately before execution:

```text
profile:read
profile:write
spaces:read
spaces:write
spaces:manage
grants:manage
resources:read
resources:write
```

Do not mechanically union legacy Application scopes. In particular, do not include retired `creation-drafts:read` or `creation-drafts:write`.

### Token TTL

`accessTokenTtlSeconds` is Application-level policy. Do not guess it from historical discussion.

Before creating the canonical Application, read the actual current TTL of all three legacy production Applications. Record the values and choose the HomeMew policy deliberately. If Mini/Web currently differ, document why the chosen unified value is safe for both; Web browser-session lifetime remains a separate HomeMew concern.

## Application × Model Access

The canonical HomeMew Application should have `write` ceiling for the current HomeMew business models:

```text
event       write
task        write
day_record  write
wish        write
```

This is only the Application ceiling. External Service Principals/Agents remain narrowed by their own credential scopes, Data Grants/Delegations and model policy. Do not add models merely because they happen to be published in LifeSpace.

Before applying, compare this list against the active HomeMew code and the legacy Applications' current model-access state. Any additional model requires an explicit HomeMew product reason.

Use the LifeSpace Console / Core Platform Admin model-access surface so the change is human-attributed and audited; do not write `application_model_access` directly in production D1 for this migration.

## Trusted Application credentials

Create new `lsa_*` credentials under the canonical HomeMew Application; do not move old credential rows between Applications.

Recommended cutover layout:

```text
HomeMew
  ├─ lsa_backend_new -> homemew-backend-production
  └─ lsa_web_new     -> homemew-web-production
```

Two credentials are an operational choice for independent deployment/rotation/revocation. They do not represent Mini and Web as different Applications. Sharing one credential would also be valid, but this migration keeps the two deployment units independently rotatable.

Plaintext is returned once. Move each secret directly into the corresponding Cloudflare Worker secret store. Never place it in repository files, issue comments, workflow summaries, URLs or persistent artifacts.

## Cloudflare Access audience

The existing `homemew.aisr.online` Access audience must ultimately be active under the canonical HomeMew Application.

The audience is the actual Cloudflare Access `aud` value, not the hostname string. Obtain it from the current production Access configuration / legacy Web Application metadata.

Because one `(issuer, audience)` can be actively owned by only one LifeSpace Application, perform the ownership switch as a controlled cutover:

1. record the current audience registration and legacy Web Application ID;
2. revoke/disable the old active audience registration only when the canonical Application is ready;
3. register the same verified audience under canonical HomeMew;
4. immediately verify HomeMew Web Access exchange with the new Web `lsa_*`;
5. if exchange fails, restore the audience to the legacy Web Application before changing any other legacy Application status.

The global `(iss, sub) -> usr_*` Access principal mapping is not migrated and must not be rewritten.

## Existing external systems

Do not migrate current HomeMew external-system Service Principals across Application ownership.

Before retiring `app_homemew_integrations_production`, use HomeMew Web / LifeSpace Console to clean the current external-system state:

- disable/revoke the relevant Service Principals;
- revoke active Service API Tokens / OAuth Client Credentials;
- revoke current HomeMew-owned Data Grants;
- disable/revoke HomeMew-created Agent credentials/bindings where applicable;
- remove/disable HomeMew-managed Eventing endpoints/subscriptions as applicable.

Do not rewrite historical audit or Change attribution.

After the single-Application cutover is verified, recreate required n8n / Agent / external-system connections from HomeMew Web. New Service Principals then belong naturally to the canonical HomeMew Application.

## Execution order

### Phase A — read-only preflight

Record:

```text
Identity contract/schema
Core contract/schema
legacy App IDs + status
legacy allowed scopes
legacy accessTokenTtlSeconds
legacy active lsa_* metadata (IDs/suffixes only)
legacy Access audience owner/value
legacy Application × Model Access
existing HomeMew external-system inventory
```

Abort on any unknown Application ownership, unexpected active Access audience, unresolved external system, or contract mismatch.

### Phase B — prepare canonical HomeMew

1. Create canonical `HomeMew` Application in LifeSpace Console with verified scopes and selected TTL.
2. Configure the canonical Application × Model Access.
3. Create `lsa_backend_new` and `lsa_web_new`; install them directly into the two HomeMew production Worker secret stores, but do not deploy the single-Application code yet.
4. Keep all three legacy Applications active at this point.

### Phase C — remove legacy external systems

Clean/revoke existing HomeMew external systems under `app_homemew_integrations_production` as described above. Confirm the operator is comfortable recreating them after cutover.

### Phase D — Access audience + HomeMew deployment cutover

1. Move the `homemew.aisr.online` Access audience from legacy Web Application to canonical HomeMew.
2. Deploy `homemew-backend-production` with `lsa_backend_new`.
3. Verify Mini provider token exchange and an authenticated Mini business read/write.
4. Deploy `homemew-web-production` with `lsa_web_new` and the single-Application HomeMew release.
5. Verify Web Access session exchange, existing-user resolution, profile/family read, one ordinary business write and integration-management entry.
6. Create one disposable external-system connection in HomeMew Web and verify the resulting Service Principal belongs to canonical HomeMew; then remove it or keep it as the first rebuilt integration.

HomeMew's release baseline must reject production before Identity `0.11.0` / schema `10`, so Phase D cannot safely run against the old LifeSpace Application model.

### Phase E — overlap and retirement

Do not immediately revoke/disable the three legacy Applications. Existing user JWTs carry their legacy `azp` until expiry.

Wait at least the maximum actual legacy HomeMew user-token TTL observed in Phase A, plus a small operational buffer, while monitoring for normal traffic still using a legacy Application context.

Then:

1. revoke legacy active `lsa_*` credentials that are no longer used;
2. disable `app_homemew_integrations_production`;
3. disable `app_homemew_web_production`;
4. disable `homemew-miniprogram`;
5. keep the disabled Application rows for historical audit attribution; do not physically delete them.

## Verification checklist

The cutover is complete only when all are true:

- LifeSpace Console Applications shows one active HomeMew Application and the three legacy HomeMew registrations are disabled;
- canonical HomeMew has the intended scope ceiling and selected TTL;
- canonical HomeMew has exactly the intended Application × Model Access;
- Mini `openid -> usr_*` mappings still resolve to the same users;
- Web `(iss, sub) -> usr_*` mappings still resolve to the same users without relinking;
- Mini and Web tokens have canonical HomeMew `azp`;
- ordinary HomeMew Event/Task/Day/Wish reads and writes succeed;
- external-system creation creates a Service Principal under canonical HomeMew;
- external-system service credentials + Data Grants authorize only the configured family/models;
- no active HomeMew path requires `HomeMew integrations production`;
- no HomeMew runtime requests `creation-drafts:*`;
- historical audit retains old Application IDs for old operations.

## Rollback

Before legacy Applications are disabled, rollback is straightforward:

1. restore the Access audience to `app_homemew_web_production`;
2. restore the previous Web Worker `LIFESPACE_APPLICATION_CREDENTIAL` secret and redeploy the previous HomeMew release;
3. restore the previous backend Worker `LIFESPACE_APPLICATION_CREDENTIAL` secret and redeploy the previous backend release;
4. leave canonical HomeMew active but unused while investigating, or disable it after its new credentials are revoked.

External systems intentionally removed before cutover are not part of rollback and may need to be recreated manually under the chosen Application after the incident is resolved.

After the legacy Applications are disabled, reactivation is still possible through LifeSpace Console as long as their credential/audience state has not been irreversibly removed; therefore do not physically delete legacy Application rows as part of this change.

## Non-goals

- No LifeSpace `Client` model.
- No credential-level scope ceiling in this migration.
- No Service Principal ownership migration.
- No historical audit rewrite.
- No automatic HomeMew production deploy from LifeSpace.
- No automatic LifeSpace production deploy from HomeMew.

# Account OAuth Staging rollout / Account OAuth 预发布验收

> Development candidate on Draft PR #469; **not a deployment instruction to bypass platform release controls**. All environment changes must use a reviewed, repository-owner-triggered workflow on `main`, or a separately approved owner-operated equivalent with the same guards. Never deploy this draft branch directly.

## Fixed topology / 已确定环境

| Environment | Account Worker | Access hostname | Persistent data |
| --- | --- | --- | --- |
| Staging | `lifespace-account-staging` | `account-staging.aisr.online` | **No Account D1** |
| Production | `lifespace-account` | `account.aisr.online` | **No Account D1** |

Both Workers independently bind their own environment's `IDENTITY` and `CORE` services. Identity D1 owns OAuth Clients/Authorizations/Tokens; Core D1 owns Spaces, Grants and Delegations. No Account database and no cross-application D1 binding.

### Owner-triggered Staging deployment / 独立发布入口

The reviewed implementation lives at `.github/workflows/lifespace-account-staging-deploy.yml`:

1. Merge reviewed OAuth foundation into `main` only after security/CI release gates. As repository owner, manually run `Deploy LifeSpace platform staging` **first** to converge Core and Identity.
2. In GitHub `staging` Environment, configure `LIFESPACE_STAGING_OAUTH_CORE_APPROVER_SECRET` and `LIFESPACE_STAGING_ACCOUNT_CSRF_SECRET` as independent random values (at least 32 characters). The existing Staging secrets `CLOUDFLARE_API_TOKEN`, `LIFESPACE_STAGING_BOOTSTRAP_SECRET`, and variable `CLOUDFLARE_ACCOUNT_ID` must remain present.
3. As repository owner on the `main` branch, manually trigger **Deploy LifeSpace Account staging**. The workflow fails closed on missing secrets, different actor/ref, unreviewed release, incompatible Core/Identity staging, or broad Access policy. It copies only the existing strict Owner-email Staging Access rule into a **separate** Account Access application, registers one dedicated minimal LifeSpace Application/Audience, deploys Account staging and injects server-only secrets to each proper Worker.
4. The workflow identifies the freshly issued Account `lsa_*` and all prior active credentials. After Account Worker Secret installation, it verifies the new credential against Identity's self-inspection endpoint, then revokes superseded credentials and confirms only the current one remains active. On failure, older keys are preserved; rerunning a successful release reconciles them. Secret plaintext is never logged.
5. Verify the Account site behind Cloudflare Access with a real browser. Finally run OAuth E2E only once its staging MCP Resource Server/Adapter has been built and reviewed. This workflow **never** deploys Production or creates a D1 database.

Do **not** manually copy a Console `lsa_*` credential, reuse a Console Audience, or enable `platform:admin` in the Account Application.

## 0. Dependencies / 前置条件

- Merge only after reviewed CI, candidate contract and threat-model checks; PR #469 is still Draft.
- Owner initiates the canonical `staging-deploy.yml` on `main`; require new Identity schema 15 and candidate Identity contract 0.18.0, with compatible Core. Do not use the experimental MCP Preview or its OAuth credentials as an excuse to break existing workflows.
- Confirm `auth-staging.aisr.online/api/v1/status` and `core-staging.aisr.online/api/v1/status` report staging and exact expected schema/contract versions. Do not skip the existing staging golden-flow verification.
- The public Account Web domain is `account-staging.aisr.online`. It is **not** the platform-admin Console (`lifespace-staging.aisr.online`).

## 1. Cloudflare Access / 登录边界

- Create one self-hosted Access application whose *only* protected hostname is `account-staging.aisr.online`. Initially use a strict **Only Me** explicit user-email allow policy, using the same validated owner identity policy as existing LifeSpace Console Staging. No Everyone, domain allow-list, broad group, or service-token inclusion. Review deny, session TTL and ingress behavior.
- Confirm Access policy protects both `/oauth/consent` and all `/api/*` paths. In particular, requests with forged `Cf-Access-Jwt-Assertion` must not bypass Access/Identity validation.
- Record the independently issued Account Access `aud`. Do **not** reuse Console or MCP Preview Audience. Identity associates each Audience to exactly one LifeSpace Application.

## 2. Account LifeSpace Application / Identity 身份源

- Via the approved Identity bootstrap/provisioning workflow (not browser JavaScript), ensure a dedicated active trusted Application `app_lifespace_account_staging` with **exactly** `profile:read`, `spaces:read`, `spaces:manage`, and 900-second JWT TTL. No platform-admin, grant modification, or service-automation scopes.
- Register the Account Access Audience in Identity **only** against that Account Application, and verify it is active and unique.
- Issue the Account `lsa_*` credential using the existing one-time secret provision mechanism. Inject it only as Account Staging Worker secret `IDENTITY_APPLICATION_CREDENTIAL`; never write plaintext into the repository, workflow logs, browser or Notion.
- Set `OAUTH_ACCOUNT_APPLICATION_ID=app_lifespace_account_staging` on **both** Core and Identity Staging (exact match). Do not change existing Console Application mapping.

## 3. Dedicated trust and OAuth settings / 凭据隔离

- Generate a new independent random `OAUTH_CORE_APPROVER_SECRET` (at least 32 unpredictable bytes) and install the **same secret** on Core and Identity Staging only. It must not equal `CORE_IDENTITY_SHARED_SECRET`, `OAUTH_RESOURCE_SERVER_SECRET` or an Account credential.
- Generate a separate random `ACCOUNT_CSRF_SECRET` (32+ random bytes) for Account Staging only.
- Set fixed Identity `OAUTH_ISSUER=https://auth-staging.aisr.online`, `OAUTH_CONSENT_URL=https://account-staging.aisr.online/oauth/consent`. Never derive the issuer from an untrusted Host header.
- Bind Account Worker `IDENTITY` to `lifespace-identity-staging`, `CORE` to `lifespace-core-staging`; verify no production bindings.
- Leave `OAUTH_ALLOWED_RESOURCES` unset and DCR disabled until the **canonical staging MCP Resource URL** and a matching protected Resource Server are deployed. Fail-closed is preferable to guessing public URLs. When ready, allowlist *only exact canonical staging Resource identifiers*.
- Provision a separate `OAUTH_RESOURCE_SERVER_SECRET` only into the intended staging Resource Server and Identity, not into the browser or Account. Never pass OAuth bearer credentials directly to Core.

## 4. Verification gates / 验收清单

1. Run `pnpm --filter @lifespace/account check` and full repository CI for the exact staged SHA.
2. Run `node apps/account/scripts/check-staging-readiness.mjs` with read-only Cloudflare API token and Account ID. This check **always reports the unverified private registration/secret gates** until an approved operator verifies them separately; do not simply override its failure.
3. As Account owner, login via Access; assert raw Access JWT does not appear in browser responses or logs. Verify non-Account issuer/app JWT, removed Space manager membership, revoked Agent Grant and revoked Agent/Application bindings all fail confirmation.
4. Verify no valid prior `request_id`, duplicate Code, wrong client redirect, PKCE downgrade, wrong Resource or revoked authorization can be replayed or exchanged.
5. Verify Application → Space → Agent → execution mode, the **pre-policy Native model upper-bound** (read/write limited by currently requested OAuth Scope), mobile UI and explicit consent click. If model preview cannot load, approval is disabled.
6. Verify Access owner-only policy, cookie `__Host` flags, no-referrer/CSP and Same-Origin CSRF on the actual deployed HTTPS hostname.
7. Run a real OAuth callback only against a reviewed, separately authenticated staging MCP Resource Server. Test distinct Client/Audience/Agent/Space isolations before declaring genuine interoperability.

## Stop conditions / 停止条件

No end-user OAuth deployment or production rollout if any of these fail: Account SSO not bound to registered Access Audience; any secret missing; callback origin not exact; current Core authority failing; effective tool operation permission absent; DCR unsafe/unbounded; token revocation not current-state; Core receives the public OAuth bearer instead of a trusted execution token; separate staging MCP Adapter not built.

### Current read-only inventory (2026-11-05)

The account-specific Access application and account Worker were **not present** in the connected Cloudflare account when checked. Existing Identity/Core Staging Workers were present but their publicly listed secret binding names did not include `OAUTH_CORE_APPROVER_SECRET` or `OAUTH_ACCOUNT_APPLICATION_ID`. This is only an inventory observation, not credential access, and must be rechecked at deployment.

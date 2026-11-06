# LifeSpace Account · OAuth Consent MVP / 用户授权门户

Account is a new **independent user-facing** LifeSpace Worker. It is not the Platform Admin Console and does not introduce a new Connection Registry. Current scope is only OAuth Consent; other Account navigation remains future work.

## Browser journey / 用户流程

1. OAuth `/oauth/authorize` creates a pending request and redirects to the configured `OAUTH_CONSENT_URL` (`/oauth/consent?request_id=oar_*`).
2. Account's Cloudflare Access-protected hostname provides the raw `Cf-Access-Jwt-Assertion` only to the BFF; Identity maps it to the registered Account Application and issues a short-lived User token. The BFF holds the token only for the current server-side request.
3. Account displays the *unverified* Client name/redirect origin, exact Resource, requested OAuth scopes and eligible manager Spaces, and presents only Agent/Application candidates with current Space Data Grants and active Identity bindings.
4. User explicitly selects Application, Space, Agent, and either Direct or **allow requests for user authorization** (not granted Delegation), then clicks Confirm.
5. The BFF checks exact Origin/Fetch Metadata, an Account-user-bound HMAC CSRF token and explicit intent; Core rechecks current Space manage + Agent eligibility and calls Identity's private approval bridge.
6. Only then does the browser follow Identity's registered OAuth callback carrying one-use Code.

This **does not** yet compute final tool-level effective Core permissions. The UI labels Grant summaries as informational upper bounds, not actual executable capabilities. Never claim real MCP OAuth support until Adapter and browser E2E tests pass.

## Secrets / 发布前条件

Register dedicated LifeSpace Account Application and Access Audience. Inject the Account `lsa_*` credential into `IDENTITY_APPLICATION_CREDENTIAL`, the independent HMAC `ACCOUNT_CSRF_SECRET`, and corresponding `OAUTH_ACCOUNT_APPLICATION_ID` in Core + Identity; provision `OAUTH_CORE_APPROVER_SECRET` to Core/Identity only. No plaintext secrets in GitHub. Keep Account behind Cloudflare Access and ensure `Cf-Access-Jwt-Assertion` is not accepted from unauthenticated public requests.

The Consent UI now displays a conservative Agent Direct Native model access upper bound from Core's current Application × Model Access and Agent Space/Model Grants, further intersected in the BFF with the actual pending OAuth Scope. It is explicitly **not** a guarantee of executable tools because Model Policy, external models, published MCP resource/tool constraints and delegated user authorization still narrow later execution. The UI refuses to confirm if the preview cannot be retrieved.

Staging readiness: run `node apps/account/scripts/check-staging-readiness.mjs` with a **read-only** Cloudflare API token and Account ID. It must find a separately protected account-staging host, strict per-email Access policy, staged Account Worker and converged Identity/Core contracts. Private Account Application/Audience and Secret checks remain manual, with fail-closed status until verified. This readiness script never mutates Cloudflare.

The owner-triggered Account Staging workflow generates its two dedicated Staging secrets on the protected runner (no manual secret-copy step); each redeploy rotates CSRF sessions and the shared Core↔Identity Staging approval secret. Original existing platform staging credentials are still required.\n\nStaging deployment is intentionally **not** performed by this PR; domain/Access registration and Core/Identity release convergence must be confirmed first. Run `pnpm --filter @lifespace/account check` for local tests and Worker dry-run.

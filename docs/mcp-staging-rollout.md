# Core-owned OAuth MCP Staging rollout (owner-controlled)

**Status (2026-11-07): private Staging Adapter deployed (Actions 42336470387),
Identity/Adapter OAuth Resource Server secret paired (Actions 42338739134),
Core Staging `MCP_ADAPTER` binding deployed (Actions 42339340052); read-only public-wire probe passed (Actions 42347634684); real OAuth E2E not yet accepted.**
This is a cross-repository
integration gate, not a new Connection Registry, Cloudflare Managed OAuth or Production launch.

## Expected service graph

```text
MCP Client → https://core-staging.aisr.online/mcp/{mcp_*}
           → Core staging: live enabled Server check
           → MCP_ADAPTER (private Service Binding)
           → lifespace-mcp-adapter-staging (no public URL)
           → IDENTITY: lifespace-identity-staging (OAuth introspection, short-lived Agent Direct JWT)
           → CORE: lifespace-core-staging (selected Space, per-model Grant, per-tool query)
Authorization browser: auth-staging.aisr.online → account-staging.aisr.online
```

The public endpoint and its RFC 9728 document use **the same exact Core host and
Server ID**. Account browser SSO remains behind Cloudflare Access; an MCP Resource
request **must not** be intercepted by an Access sign-in redirect. Only Identity
accepts the opaque public OAuth token; the Adapter cannot bypass Core Grants.

## Prerequisites (no deployment unless all satisfied)

1. Review and merge **LifeSpace #480 before dependent #485**, and **Adapters #29
   before dependent #30**. Do not deploy one stack on an old parent revision.
2. Both repositories' latest combined CI must pass, including synthetic 20-model
   batch tests, no-token/invalid-token metadata challenge and disabled/removed
   tool tests. The Cloudflare Worker-to-Worker request budget is 32 invocations.
3. The **lifespace-adapters** repository must have a protected GitHub
   `staging` Environment with its existing `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`. The **LifeSpace** repository staging Environment
   must also have its existing Cloudflare deploy credentials. Do **not**
   copy or store the cross-Worker Resource Server secret in either repository:
   the owner-only LifeSpace paired-secret workflow generates it once per run
   and writes it directly to both exact Staging Workers.
4. Confirm `lifespace-core-staging` and `lifespace-identity-staging` exist
   in the **same Cloudflare account**. Preserve HomeMew/n8n existing production
   Service and Agent credentials. Core/Identity's shared internal secret must
   remain converged. Verify Current Core MCP schema is already migrated.

## Exact release order

1. Run the *owner-only manual* **Deploy private LifeSpace MCP adapter staging**
   GitHub workflow in `lifespace-adapters` on reviewed `main`. It uses
   `adapters/mcp/wrangler.staging.jsonc`, disables workers.dev and previews,
   declares no routes and binds private CORE and IDENTITY. This first deployment
   deliberately omits the secret: the Adapter fails closed until the next step.
2. Run **Converge private MCP OAuth staging resource secret**, the owner-only
   LifeSpace `main` workflow. It verifies both exact Staging Workers already
   exist, generates one new cryptographically random Resource Server secret,
   writes it to Identity Staging **and** private MCP Adapter Staging through the
   Cloudflare API, and checks both binding names without reading secret values.
   A partial failure blocks E2E; rerun the workflow to pair a new secret.
3. Deploy the reviewed LifeSpace **Identity/Core** `main` through the protected
   platform Staging release. The **Core `MCP_ADAPTER` Service Binding** is a
   separate final release change after Adapter existence, generated Wrangler
   types and full candidate CI are verified. Until then Core's ingress returns
   503, not a fallback business API. Production Core has no Adapter binding.
   The Identity staging `CORE` binding validates current `mcp_*` enabled
   state before OAuth/Consent.
4. Create/enable a harmless `mcp_*` Server with one read-only published model
   on an isolated Staging Space/Agent. Ensure Account shows the actual
   Application, Space, Agent, execution mode and *requested* read capability.
   An Agent Direct read does not imply User Delegation. Do not reuse real user data.
5. Set `LIFESPACE_STAGING_MCP_RESOURCE_URI` to the exact
   `https://core-staging.aisr.online/mcp/{mcp_*}` URL and run
   `node infra/scripts/verify-staging-mcp-server-wire.mjs`. Passing checks
   only RFC 9728 document, Identity issuer+PKCE metadata, Bearer 401 challenge
   and invalid-token denial — **not OAuth/Consent/data E2E**.
6. Run a *real* registered Staging OAuth client through Authorization Code+PKCE,
   Account browser Consent, token exchange, stateless `server/discover` /
   `tools/list` / `tools/call` (or legacy `initialize`), and a bounded
   Core read-only query. Verify the client is unverified in Account UI.
   Validate wrong Server audience, cross-Space, disabled Server, revoked
   authorization, refresh-token replay, changed query operation, invalid
   `Mcp-Name`, and OAuth metadata mismatch all fail closed.
7. **OAuth client settings (schema 18)**: after the platform Staging
   migration and separate Console deploy, go to **Platform → OAuth 客户端**.
   The page has only CIMD and DCR enable switches, plus one optional
   **Allowed callback URLs** field. Do not register per-connection callbacks
   in Console. Leave the callback field empty for the normal self-service
   flow; the per-client exact-match rule remains mandatory.
8. Schema 18 intentionally disables a previously enabled strict CIMD/DCR
   policy before retiring its old whitelist; the operator must explicitly
   re-enable that feature. Existing open methods remain enabled.
9. **ChatGPT Staging E2E**: verify CIMD using the actual client metadata URL,
   and DCR fallback if needed. With RFC 9207 issuer support ChatGPT may use
   the stable `https://chatgpt.com/connector_platform_oauth_redirect`.
   Old connections can use callback-specific URLs; register the exact URI
   on that OAuth Client, not in Console.
10. Test PKCE, Account Consent and user denial, callback mismatch rejection,
    cross-Server/Space denial, tool invocation, revocation, rate limits and
    D1 quotas. Do not open Production before the outbound metadata security
    and abuse review.

## Explicitly out of scope

- No Production Worker, route, OAuth secret, D1, Space, or Data Grant mutation.
- No new `conn_*`, Account database, OAuth-managed User Delegation, or
  Cloudflare Managed OAuth.
- No assumption that green CI proves live ChatGPT/Claude interoperability.
- Do not promote this work while the private Worker or client registration
  interoperability is missing.

## 2026-11-09 · User-owned delegated lifetime decision (development)

Account second-stage web approval, independent of OAuth login consent, supports **once** (default; max 1 use and 30 minutes), **timed** (repeat exact operation for 1h/24h/7d), and **until revoked** (repeat exact operation until User revocation). The third-party Agent does not submit or choose an expanded lifetime; Core accepts lifetime selections only from the signed-in intended Account User, through the CSRF-bound BFF. Long-lived grants are revocable at Account `/delegations` without requiring a live OAuth client token. OAuth revocation and Space/Model/Data Grant reduction remain authoritative on every call. Model+operation targeting is unchanged and may encompass multiple records, explicitly disclosed to users. Trusted ALOHA/WeCom confirmations are unaffected.

Implementation is not yet deployed or real Staging-accepted.

# MCP OAuth: Platform / Application / Account

## Delegation trust boundary / 委托两类信任边界

LifeSpace classifies **the verified approval channel**, not the programming
framework, by trust. Using n8n Nodes, WorkBuddy, a bot, a particular OAuth
client name, or an MCP transport **never makes an application trusted**.

| Trust class | Verified precondition | Human confirmation | Execution authority |
| --- | --- | --- | --- |
| **Trusted / 可信应用** (ALOHA, or a carefully verified enterprise messenger Router built with n8n) | LifeSpace-issued bounded Application/Agent credentials **and** the application/backend has independently verified the human identity, tied the incoming chat/session to a fixed LifeSpace `usr_*`, and protected its confirmation Router from injection/replay | Existing in-app UI or verified enterprise chat Router; `principalUserId` is only asserted by that separately trusted backend | Existing Agent `arq_*` trusted confirm/deny and Core `dlg_*`; **no change in this release** |
| **Untrusted third-party / 不可信第三方** (ChatGPT, Claude, 豆包, WorkBuddy, other non-owned clients) | Dynamically registered/validated OAuth Client and an explicit, live User Consent for exact Application/Agent/Space/MCP Resource and scopes; client metadata/name is not a trusted identity assertion | Explicit LifeSpace Account HTTPS URL; Account independently authenticates its User via verified Access→Identity, requires CSRF-safe same-origin approve/deny and matches the immutable `arq_*` | Core issues bounded, single-use `dlg_*` only after Account approval; represented User Principal / Agent Actor is checked on each execution |

**Security invariants:**
- An OAuth/third-party Agent cannot create a trusted request, approve it, claim a User ID or use trusted confirmation APIs merely because it executes in n8n or has the same Agent identity.
- The trusted Agent confirmation API must reject **all explicitly tagged externally approved `arq_*` channels**, including new future channels; the third-party Account endpoint must accept only `channel:oauth_mcp` and the independently signed-in intended User. Both use the same Core `arq_*`/`dlg_*` facts but not the same authority to confirm.
- Consent to `resources:write` and `allowUserAuthorization` permits **requesting** appropriate operations, not executing under User authority. Direct OAuth execution remains Principal=Actor=Agent unless an exact already-approved Delegation is supplied. Cached MCP tool names are never permission.
- A capability subset is legitimate: an external Provider or Kernel Person operation unsupported by the canonical Core runtime must be absent or unavailable, not invented in Adapter or made broad through Space Delegation. In particular, External Provider writes cannot claim atomic single-use Delegation consumption across the provider boundary.
- Future alternative untrusted confirmation channels may be added after separate review; none may fall back to the trusted `principalUserId` confirmation transport.

**Scope of this release:** preserve all already existing trusted ALOHA/WeCom/Agent API flows, implement and verify the Account-link channel for third-party OAuth MCP, and enforce current Model/Provider operation ceilings. No n8n framework-based trust classification, no second Delegation store and no automatic conversion of existing trusted applications.

## Ownership

| Owner | Responsibility |
| --- | --- |
| **LifeSpace Console** | Only two protocol switches (CIMD and DCR) plus one optional **Allowed callback URLs** list. Platform security, abuse protection, logging and client disablement remain server-side. |
| **Application / MCP Server** | Which models, tools, actions, scopes and execution modes the application exposes. Live Core permission checks still apply. |
| **Account** | User chooses Application, Space, Agent, execution mode and data scopes on Consent; user can review and revoke their own authorizations. |

**No platform administrator should need to register each ChatGPT/Claude/user callback URL.**
OAuth client registration never implies a user Grant or Delegation.

## Simplified Console OAuth settings (Identity schema 18)

- **CIMD** switch requests automatic discovery of eligible public HTTPS
  Client ID Metadata Documents. Admission is controlled solely by the current Console policy. Safety prerequisites include both rate limiters and **Cloudflare's
  `global_fetch_strictly_public` compatibility flag** on the deployed Identity
  Worker. This forces untrusted `fetch()` through the public-Internet network
  boundary, even when a URL refers to the Worker's own zone; it does not
  bypass Cloudflare security to reach a private origin. Do not attach a VPC
  Network/private egress binding to CIMD. Each environment has its own Identity D1 policy, default disabled on fresh install; the owner changes it directly in Console without redeployment. The native DNS precheck rejects nonordinary A/AAAA addresses; it does not pin the eventual connection. Cloudflare strict-public fetch and no private bindings are the network boundary.
- **CIMD HTTP freshness (schema 19 candidate, #580):** reuse only successfully validated public metadata within explicit publisher freshness, capped at five minutes. Each lookup checks current Client status, exact callbacks and Console revision; expired/noncacheable metadata requires fresh guarded DNS/HTTPS. No stale/error fallback, no cached User/Agent/Space authority. Local disable and policy changes remain immediate; publisher changes may be observed at freshness expiry. See [Identity OAuth](./identity-oauth.md).
- **DCR** switch enables protected dynamic client registration with validated
  callbacks, rate limit and an atomic D1 client quota. Unreferenced anonymous
  clients older than seven days are reclaimed in bounded on-demand batches;
  no client with pending requests, authorization/code/token references, or
  explicit disablement is auto-removed. Expired unbound request attempts
  older than one hour are deleted in bounded batches.
- **Allowed callback URLs** is **one optional platform-wide exact-match list**.
  Empty (default) means no **additional** platform limitation. With entries,
  the registered client's requested redirect must also be in the list.
  **Every** OAuth authorization and token exchange still checks the
  requesting client's own registered callback exactly, including when
  the platform list is empty. No URL wildcards are accepted. Native local
  loopback redirects follow the existing per-client validation.
- Existing schema 17 strict CIMD/DCR allowlists are retired. Migration
  `0018` disables a previously enabled *restricted* method before switching
  it to automatic mode; an administrator must explicitly re-enable it.
  Existing *open* methods remain enabled. Existing explicitly restricted
  global callback URLs remain in place. This avoids accidentally granting
  broader registration authority on deployment.
- Console is the sole runtime feature switch for CIMD and DCR. Existing stored policy values remain unchanged; removing the former deployment switches makes those current values effective. Both environments require
  `OAUTH_DCR_RATE_LIMITER`; `/oauth/authorize` separately requires
  `OAUTH_AUTHORIZE_RATE_LIMITER` (100/minute per colo) plus an atomic D1
  quota of 1000 **live pending** requests. Missing rate limiter fails closed.
  The per-colo limiter is not a global quota. Production activation requires separate owner approval and actual Staging admission evidence; the residual special-use DNS TOCTOU compliance gap is explicitly accepted. No migration or deletion of valid
  OAuth client credentials, authorizations or tokens is permitted.

## 2026-11-12 · CIMD native strict-public fetch decision (candidate, NOT deployed)

- Previous candidate used a dedicated `OAUTH_CIMD_EGRESS` VPC/Gateway
  binding. This was intentionally **not** provisioned, because
  `cf1:network` can also reach private Tunnel/Mesh/WAN routes.
- Cloudflare's documented `global_fetch_strictly_public` compatibility
  flag provides a simpler public-only network boundary: global `fetch()`
  requests, including same-zone URLs, traverse Cloudflare's public entry
  rather than the zone's private origin bypass. The Workerd public outbound
  network refuses private IP destinations at the actual connection layer.
  This protects against a DNS answer that changes from public to private
  between an application-layer preflight and the actual connection; no
  application-side DNS preflight is treated as proof.
- The flag is declared for both Staging and future Production Identity
  deployments, so enabling the CIMD feature cannot rely on the unsafe
  same-zone origin bypass. **No Production deployment is performed by this
  change.** The owner-only deployment gate remains; after deployment, the respective Console policy alone controls discovery. Existing OAuth clients, grants and tokens are preserved.
- `infra/scripts/audit-staging-cimd-egress.mjs` reads the actual Worker
  settings and requires: deployed strict-public compatibility flag,
  both rate limiters, no legacy admission switches, and no private network/relay bindings. The same read-only audit runs for Production. It
  verifies safe configuration, **not** a live SSRF/DNS rebinding attack.
- Owner decision: do not deploy the independent Node relay from #539. Reuse existing public/private and authoritative DNS-flip evidence; run live Staging admission on the new candidate. No extra DNS mutation or independent service is required. DNS preflight is not connection pinning; full draft conformance for globally routable special-use addresses is not claimed. Reassess if private networking is introduced. Production remains separately gated.

## 2026-11-11 · Controlled authoritative DNS flip acceptance (historical; executed, #43146480112)

- Owner-gated `.github/workflows/staging-cimd-dns-flip.yml` uses the
  previously vetted isolated Cloudflare remote preview with
  `global_fetch_strictly_public`, no Identity D1/Service/VPC connections.
  It creates **one unpredictable DNS-only A record** under
  `cimd-rebind-<nonce>.aisr.online`, initially pointing at the public
  `1.1.1.1`, and then changes the **same** record to deliberately
  unassigned/private `10.255.255.254`. TTL is 120 seconds.
- The script first checks the hostname does not exist, and obtains the
  current exact DNS zone and authoritative NS names directly via the
  Cloudflare API. It requires both nameservers to agree on the public
  address, then both to agree on the private address; after an extra
  130-second cache expiry delay it probes the fixed hostname through
  the temporary remote Worker again. The request can never choose
  arbitrary destination names or paths; no remote response body is
  exposed to the caller.
- **Cleanup is not optional**: a `finally` block re-reads the exact
  DNS record ID, hostname, type, and unproxied state before deleting
  it, then verifies no record remains. Cancellation or force-kill
  before cleanup may still require an operator to inspect
  `cimd-rebind-*.aisr.online` for an abandoned record. The workflow
  requires direct Owner dispatch from main, not PR CI.
- **Evidence interpretation**: this demonstrates authoritative DNS
  changing **between requests** and checks that no HTTP 2xx occurs
  after the private transition. It **cannot** establish which cached
  answer the Worker used or a change **within one TLS connection**.
  Both results must be reported explicitly. Therefore this test
  alone must not be cited as a complete DNS rebinding security proof
  or used to enable Staging/Production CIMD. The lower-level
  strict-public network enforcement and existing negative direct-IP
  tests remain essential.
- The DNS test adds/removes a *new, random, isolated record* in the
  existing Cloudflare `aisr.online` zone, **never** existing service
  records. No LifeSpace Staging or Production Worker is deployed,
  no OAuth token is created, and no Cloudflare Gateway private
  traffic policy is changed.

## Expected journey

1. User connects a compatible MCP Server from ChatGPT/Claude/etc.
2. Identity accepts safe automatic client metadata discovery (CIMD) or DCR,
   without a Console visit for that user's callback.
3. Account displays the actual client request and the requested MCP resource.
   User chooses Application/Space/Agent and explicitly consents.
4. Identity issues a resource-bound token. Core restricts the caller to
   the current published MCP tools, application model policy and Grants.
5. User revokes or manages the authorization in Account.

Where supported by the client, RFC 9207 stable ChatGPT OAuth redirect uses
`https://chatgpt.com/connector_platform_oauth_redirect` after Identity
advertises the issuer response parameter and includes matching `iss` on
both successful and user-declined Consent responses. The client must still
register this exact redirect.

## Staging acceptance

Deploy Identity migrations before the Identity Worker, then separately
deploy Console Staging. Confirm the Console has just two switches and one
optional callback field, and that disabled switches remove their OAuth
discovery advertisement. Verify DCR auto registration and (when enabled in Staging Console)
CIMD metadata discovery, both registered callback exactness and optional
global callback restrictions, PKCE, the Account consent and denial callbacks,
cross-MCP-resource isolation, Token revocation, both rate limiter failures,
live pending-request quota, orphan registration cleanup, and native strict-public configuration plus bounded DNS precheck. Deployment acceptance reads the actual Console policy; if a feature is off it checks denial and explicitly reports positive acceptance as not run.
Production is not approved until the additional outbound-metadata
security and abuse review is complete.

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
  Client ID Metadata Documents. The effective runtime additionally requires
  `OAUTH_CIMD_ENABLED=1`, DCR rate limiter and a **dedicated, policy-enforced
  `OAUTH_CIMD_EGRESS` binding**. A regular global Worker `fetch` is forbidden
  for untrusted metadata documents, and no egress binding is supplied by
  default. Egress policy must be independently verified to block all special
  IP ranges and DNS rebinding at connection time. Until verified, CIMD remains
  unavailable (including when the Console switch is on). Metadata parsing,
  no redirect, callback pinning and document size limits remain mandatory.
  An unverified client name is **not** vendor identity proof.
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
- Runtime `OAUTH_CIMD_ENABLED` and `OAUTH_DCR_ENABLED` remain independent
  deployment release/incident switches. Both environments require
  `OAUTH_DCR_RATE_LIMITER`; `/oauth/authorize` separately requires
  `OAUTH_AUTHORIZE_RATE_LIMITER` (100/minute per colo) plus an atomic D1
  quota of 1000 **live pending** requests. Missing rate limiter fails closed.
  The per-colo limiter is not a global quota. Production cannot activate
  arbitrary-CIMD discovery before verified Secure Egress policy and real
  DNS rebinding/SSRF negative tests. No migration or deletion of valid
  OAuth client credentials, authorizations or tokens is permitted.

## 2026-11-11 · CIMD Secure Egress release gate (candidate, NOT deployed)

- Staging deliberately sets `OAUTH_CIMD_ENABLED=0` until an independent, staged
  private-IP / DNS-rebinding security acceptance is complete. This is in
  addition to the Console admission switch and the missing-by-default
  `OAUTH_CIMD_EGRESS` network binding. Enabling a VPC binding by itself
  **does not** make arbitrary CIMD discovery safe.
- Workers VPC `cf1:network` reaches both public Internet through Gateway and
  private Tunnel/Mesh/WAN routes. Attaching it without verified Network
  policies may *expand* SSRF reachability. Cloudflare Gateway DNS/HTTP
  filtering alone is not evidence that final resolved IPv4/IPv6 addresses
  are blocked at connection time. Any private/special-purpose destination or
  DNS rebinding attempt must be blocked before rollout.
- The separate `infra/scripts/audit-staging-cimd-egress.mjs` performs a
  read-only cloud configuration inspection and **only accepts safe closure**
  (Staging flag disabled and Egress binding absent). An enabled Gateway rule
  is reported but is *not* treated as penetration-test evidence. The
  canonical Owner-dispatched staging workflow runs this after Identity deploy.
  No automatic workflow can modify the canonical Staging or Production
  release approvals.
- To move toward open CIMD, separately design a constrained egress path,
  prove it cannot route to private/special IPv4/IPv6 addresses including via
  changed DNS resolutions, then extend the audit from strict safe-closure to
  a reproducible security-proof check. Until then, DCR is the available
  automatic OAuth client registration mechanism.

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
discovery advertisement. Verify DCR auto registration and (only after secure egress provisioning)
CIMD metadata discovery, both registered callback exactness and optional
global callback restrictions, PKCE, the Account consent and denial callbacks,
cross-MCP-resource isolation, Token revocation, both rate limiter failures,
live pending-request quota, orphan registration cleanup, and final egress
network policy including DNS rebinding. A staging CIMD switch alone is not
sufficient for successful discovery.
Production is not approved until the additional outbound-metadata
security and abuse review is complete.

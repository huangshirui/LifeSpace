# LifeSpace Identity

Global LifeSpace user registry and credential issuer for LifeSpace applications.

## Phase 1 scope

- Global LifeSpace users (`usr_*`)
- Trusted application/client registration
- Per-application revocable backend credentials
- Trusted-backend user creation
- Short-lived Core access token issuance
- Token revocation and signing-key lifecycle foundation

Application-specific external identities are deliberately out of scope. HomeMew keeps WeChat `openid -> user_id` mapping in its WeChat Cloud Function/database; other applications keep equivalent provider mappings in their own adapters/BFFs.

## Trust flow

```text
Application adapter/BFF
  -> authenticates its external user/provider identity
  -> resolves or creates LifeSpace usr_xxx
  -> authenticates to Identity using its own application credential
  -> requests a short-lived token for usr_xxx
  -> Identity derives azp from the authenticated application
  -> Identity limits requested scopes to the application's registered maximum
  -> client calls LifeSpace Core with the short-lived token
```

The application credential is backend-only and must never be exposed to browser or Mini Program code.

`BOOTSTRAP_SECRET` is only for platform administration/bootstrap, such as registering a trusted application and generating its initial credential. It is not a permanent shared credential for applications.

Space membership, Data Grants and life-domain authorization remain Core responsibilities.

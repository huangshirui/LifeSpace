# LifeSpace Identity

Global LifeSpace user registry and credential issuer for LifeSpace applications.

## Scope

- Global LifeSpace users (`usr_*`)
- Trusted application/client registration
- Per-application revocable backend credentials
- Trusted-backend user creation
- App-policy Core access token issuance
- Token revocation and signing-key lifecycle foundation

Application-specific external identities are deliberately out of scope. Each application keeps provider-specific subject mappings in its own adapter/BFF and resolves them to LifeSpace `usr_*` identities through the approved trusted-application flow.

## Trust flow

```text
Application adapter/BFF
  -> authenticates its external user/provider identity
  -> resolves or creates LifeSpace usr_xxx
  -> authenticates to Identity using its own application credential
  -> requests a Core token for usr_xxx
  -> Identity derives azp from the authenticated application
  -> Identity limits requested scopes to the application's registered maximum
  -> Identity applies that application's configured access-token TTL
  -> client calls LifeSpace Core with the token
```

The application credential is backend-only and must never be exposed to browser or Mini Program code.

`BOOTSTRAP_SECRET` is only for platform administration/bootstrap, such as registering a trusted application and generating its initial credential. It is not a permanent shared credential for applications.

## Access-token lifetime

Access-token lifetime is an application policy, not a caller-controlled request field.

- Allowed range: 300-3600 seconds.
- Default: 900 seconds.
- Core enforces the platform maximum of one hour but does not decide each application's exact TTL.

Space membership, Data Grants and life-domain authorization remain Core responsibilities and are evaluated against current Core state rather than encoded as long-lived mutable permissions in the token.

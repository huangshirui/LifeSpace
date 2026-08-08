# Infrastructure Agent Instructions

`infra/` documents and, when appropriate, contains shared deployment configuration that is not owned by one application repository.

## Rules

- Keep production and staging resources isolated: Workers, D1 databases, R2 buckets, Queues, secrets and routes must not be shared accidentally across environments.
- Core and Identity are separate deployable services even when they are maintained in one repository.
- Application domains belong to application deployments; `core.aisr.online` and `auth.aisr.online` are platform service endpoints.
- Prefer Cloudflare Service Bindings for trusted same-account Worker-to-Worker calls where appropriate.
- Do not encode application identity or authorization by hostname. Host routing is not a permission boundary.
- Infrastructure-as-code or Wrangler configuration must not contain secrets.
- Resource provisioning must be idempotent. Do not make every application deployment responsible for creating shared platform resources.
- Any destructive infrastructure or production data change requires explicit migration/rollback reasoning and environment verification.

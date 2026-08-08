# LifeSpace Infrastructure

Planned shared Cloudflare topology:

```text
auth.aisr.online -> Identity Worker
core.aisr.online -> Core Worker
```

Application domains such as ALOHA and HomeMew remain owned by their application repositories and may use a same-origin BFF that reaches Core through a Service Binding.

Production/staging resource definitions and deployment workflows will be added here or with the owning service only when implementation begins. No Cloudflare resources are provisioned by this scaffold.

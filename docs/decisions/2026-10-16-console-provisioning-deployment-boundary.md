# Console staging provisioning vs platform deployment topology

Status: accepted 2026-10-16.

## Decision / 决策

`Converge LifeSpace staging control plane` is a Console/control-plane provisioning workflow, not a platform deployment workflow.

It may:

- read the deployed Core and Identity `/api/v1/status` surfaces and require the exact candidate contract/schema versions;
- reconcile Console Application / Platform Administrator / executor credentials through canonical APIs;
- build and deploy the Console Worker.

It must not:

- run Core or Identity migrations;
- deploy Core or Identity Workers;
- mutate Core/Identity custom-domain topology;
- provision or replace External Provider Service Bindings or `EXTERNAL_PROVIDER_ROUTES`.

Canonical `Deploy LifeSpace platform staging` owns Core/Identity deployment topology, migrations and generated External Provider routing. If the deployed platform does not match the Console candidate, Console provisioning fails closed and instructs the operator to deploy the canonical platform candidate first.

## Incident / 事故背景

A canonical staging platform release correctly installed the Notion Adapter Service Binding and generated Provider routing. A later Console control-plane convergence run executed a plain `wrangler deploy --env staging` for Core from `apps/core/wrangler.jsonc`. That deployment preserved D1 External Connection/binding rows but removed generated Provider routing from the live Worker settings. Runtime filtering then made the active registration appear unavailable and `Refresh schema` returned `NOT_FOUND / Registration not found`.

The Console staging-isolation guard now rejects any provisioning workflow that reintroduces Core/Identity migration/deployment or External Provider topology mutation.

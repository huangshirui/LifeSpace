# Phase 8 repository stabilization status

Date: 2026-08-26  
Status: repository cleanup in review

## Purpose

Phase 8 closes migration-era repository surfaces now that HomeMew production business data is authoritative in LifeSpace and the HomeMew Web production front door has completed cutover.

This is an active-tree cleanup, not a destructive production-resource cleanup.

## Retired from the active LifeSpace tree

- the purpose-built `infra/migration/` HomeMew -> LifeSpace one-shot migration implementation used for Phase 5 rehearsal and Phase 7 production cutover;
- the pre-cutover `HomeMew Web production provision` GitHub Action;
- `infra/scripts/prepare-production-homemew-web.mjs` and its static provisioning test, which encoded the one-time pre-cutover application/AUD/credential preparation path and an obsolete Core contract gate.

The corresponding migration implementation and execution history remain available in Git history and the completed Phase 5/Phase 7 plans/status evidence. They are not reusable platform migration APIs.

## Retained as long-lived platform capability

- normal `Check`, staging deploy and guarded production deploy workflows;
- APAC performance gates;
- current HomeMew Web staging authority/model/integrations provisioning used for ongoing application development;
- current LifeSpace Console staging provisioning/deployment paths;
- production create-if-missing infrastructure provisioning and verification;
- historical phase plans/status documents as audit evidence.

## HomeMew repository counterpart

The HomeMew application repository is retiring its legacy `apps/core`, old Core CI/deploy workflows and one-time Web cutover tooling in the matching Phase 8 cleanup. HomeMew remains an application layer over LifeSpace rather than a second business Core.

## Runtime-resource boundary

No production D1 database, Worker, Queue, R2 bucket, Custom Domain, Access application, application credential or other Cloudflare runtime resource is deleted by this repository cleanup.

Any still-existing legacy HomeMew Worker/D1 resources must remain frozen/read-only while they are retained for stabilization or rollback evidence. Physical resource deletion is a separate operations decision and must re-verify current production authority, traffic ownership, rollback requirements and retention needs immediately before execution.

## Forward rule

Completed migration/cutover executables should not remain normal operator entrypoints. If a future product needs another migration, build it against the then-current platform contracts and an explicitly approved migration plan rather than reviving the frozen HomeMew one-shot implementation.

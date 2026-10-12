# Recurrence / 通用计划到任务生成

Development contract for #338; not a production release claim. Recurrence is Shared World (durable Plan/Task/occurrence), supported by Semantics and governed Change. It serves Space Boundary, Durable Shared Reality, Bounded Authority and Governed Change. Temporal `cycle` remains a separate time-state/history capability and creates no Task.

## Model binding / 模型绑定

An ordinary Plan-like model opts in through declared fields, without domain-model dispatch:

```json
{
  "capabilities": {
    "recurrence": {
      "ruleField": "recurrence",
      "firstDueDateField": "firstDueDate",
      "statusField": "status",
      "endDateField": "endDate",
      "task": {
        "nameField": "name",
        "descriptionField": "instructions",
        "subjectField": "subjectPersonId",
        "assigneePersonField": "assignees"
      }
    }
  }
}
```

`ruleField: recurrence_rule`, `firstDueDateField: date`, `statusField: enum` containing `active/paused`; any other status stops new materialization. `endDateField: date` is optional. Task title is string/text, description is optional string/text, subject is optional person/record/entity_ref, assignee is optional person/person_list. Business values remain model fields; metadata only assigns roles. A non-null rule requires firstDueDate; startDate never substitutes for it. End date must not precede firstDueDate. The generated `task` target cannot itself opt in as a Plan.

No HealthRegimen, MaintenancePlan or other new ordinary model is made a baseline by this feature. They can be published normally with this binding.

## Rules / 周期规则

```json
{"mode":"calendar","frequency":"daily","interval":1}
{"mode":"calendar","frequency":"weekly","interval":2,"weekdays":["MO","WE"]}
{"mode":"calendar","frequency":"monthly","interval":1,"monthDays":[1,31]}
{"mode":"calendar","frequency":"yearly","interval":1,"dates":[{"month":2,"day":29}]}
{"mode":"after_completion","interval":{"value":30,"unit":"day"}}
```

Values are closed, canonical structured objects. Intervals are positive integers bounded at 10000. Empty/duplicate selection arrays, unknown properties, impossible yearly month/day pairs and Cron/code are rejected. Week starts Monday. Interval phase starts with the calendar period containing firstDueDate. For example Wednesday 2026-10-14 + every two weeks on Monday first produces 2026-10-26. Calendar month-day 31 skips February/April; yearly February 29 skips non-leap years. Completion month/year arithmetic clamps: January 31 + one month = February 28; February 29 + one year = February 28.

Task dueDate remains date-only. Completion instant is converted to a date in the current Space timezone. The rule does not store firstDueDate or a timezone. Hourly/time-of-day recurrence, holiday calendars, nth weekdays and condition/external-event triggers are outside V1.

## Runtime and lifecycle / 运行与生命周期

- Calendar occurrences are independent of Task completion. New Plans begin at firstDueDate and materialize a bounded part of the execution window; persisted cursors resume remaining work. Existing occurrences/history are never recomputed.
- Completion-based Plans materialize the first Task at firstDueDate. Only successful `complete` advances from actual completion date; overdue Tasks do not jump. Cancel stops advancement. `skip-occurrence` explicitly marks the current occurrence skipped and calculates its successor from the skip date; it does not fake completion.
- Completion, successor Task, generated_from, governed Changes and cursor/occurrence state commit in one D1 transaction. Stable database uniqueness and optimistic state guards reject concurrent duplicate advancement. Reopening an older Task does not reclaim the cursor or create a second successor.
- Pausing retains existing Tasks and stops new generation. Completing while paused records the anchor without creating a successor. Resume retains a current unfinished Task; otherwise it creates the next Task, clamping a past candidate to the resume date. Calendar resume skips paused history and preserves already materialized future Tasks.
- Rule/firstDueDate edits cancel old-rule unfinished future Tasks, preserve due/completed history, increment scheduling revision and create replacement future occurrences. Removing the rule cancels future unfinished generated Tasks and stops scheduling. EndDate stops generation beyond it; already materialized Tasks remain independent records.
- Task title/description/subject/assignees are copied at generation. Task.subject is a first-class Person/Record entity_ref; generated_from is the existing Semantic Relation. The read-only immutable recurrenceOccurrenceId lets ordinary Task completion avoid any recurrence query.

## Authority / 权限与内部执行

Enrolling or materially replacing a recurring intent requires current Plan write and Task write through the calling Application and selected Delegation, when represented. One selected Delegation must cover both accesses; a Space-scoped Delegation can do this. Record/model-scoped Delegations cannot silently expand to the Task collection. User/Service/Agent roots are supported; Device roots are outside this Identity projection.

Enrollment stores only the verified Root Principal, Application and a bounded scope ceiling. No credential, JWT or short-lived dlg is saved. Expiry/revocation of the original invocation credential is not the cancellation mechanism for an already-authorized durable Plan. Pause/remove the rule, revoke current Membership/Data Grant/Application Model Access, or disable the enrolled Root/Application to stop generation. For represented User/Agent enrollment the durable Root remains User; replacement of that originating Actor does not replace the User's Plan.

Every generating request/rolling batch performs one set-wise Identity call for current Root/Application status and scope ceilings, plus set-wise current Core Authority and model Policy checks. Current Core Space/Membership/Grant/Application access is checked again inside the generation commit guard. Identity failure fails closed. There is no positive authority cache across requests. The service Actor is `svc_lifespace_recurrence`; its unforgeable in-process context is issued only by the recurrence engine. HTTP bodies/JWT claims cannot manufacture that internal exemption. Each committed Change preserves Root Principal, internal Actor and Application.

If successor generation is denied, an active completion-based complete/skip transaction fails as a whole; it does not partly complete and create an unauthorized Task. Pausing the Plan allows completion to record the anchor without generating a successor.

## Scheduling and performance / 调度与性能

Core's existing Scheduled handler drains bounded indexed work. The batch selects the oldest due Space and at most 20 due Plans in that Space, preserving the existing one-Space mutation boundary. Global and Space-local next_materialize_at indexes prevent full-plan scans; this instant derives from a local date boundary, so UTC polling does not starve other timezones. Active future occurrences use a partial plan/date index; current/history lookups use stable IDs.

`RECURRENCE_WINDOW_DAYS` is an internal 0..90 setting (initial default 30), not a domain rule. One invocation materializes at most 20 Tasks across the selected Plans. Mixed batches reserve completion-based first/successor Task slots before expanding calendar windows. Persisted cursor/state revisions make bounded continuation/retry recoverable. Same-root generated Changes share a batch ChangeSet/event envelope. Different roots retain distinct attribution groups; application notification aggregation stays downstream.

Regression budgets: hot 20-Plan User JWT/Service Token path <=8 Core D1 RTT; represented opaque Agent <=9 (one bounded chain-resolution RTT). One current-root Identity call per request/batch, plus one credential introspection for each opaque authenticated request. Indexed rolling one-Space batch <=8 Core D1 RTT. The 1000 parked-Plan fixture reads <1000 D1 rows; this is a fixture-specific guard, not a universal rows-read SLA. Ordinary Runtime/Temporal paths retain their existing gates.

## Contract and rollout / 契约与发布

Kernel development version 0.51.0 exposes the new field types, structured valueSchema and Recurrence bindings in Space/configuration semantic Discovery. Immutable Model Contracts carry the full schemas, conditional creation constraint, binding metadata and Task skip Action. Generic n8n/MCP/Agent/UI consumers should read these projections, not infer field names or implement their own scheduler. Strict generated consumers must pin compatible new Kernel/Model revisions; production pins remain unchanged until release.

Deploy Identity 0.12.0's internal recurrence-roots projection (classified Candidate Internal) first, apply additive Core migration 0057, then deploy Core. Existing Task fields/data and historical Model/Change records are retained. Do not remove migration 0057 on rollback; pause Plans and roll back the Worker. Deployment order is a fail-closed compatibility boundary. Exact-candidate staging and real deployed JWT/Service/Agent latency measurements remain required release gates, and production documentation advances only after successful production deployment.

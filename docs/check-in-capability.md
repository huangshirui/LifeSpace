# Check-in Capability / Habit 打卡能力

## Boundary and status / 边界和状态

LifeSpace Core owns the check-in truth and authoritative `streakDays` computation. A Habit is an ordinary metadata-driven Native Model, not a handwritten Kernel entity. The reusable closed Capability is called `checkIn`; only models with a validated `capabilities.checkIn` declaration expose it. This is an implementation candidate until the relevant PR is merged and staging validated.

LifeSpace's Temporal `record-occurrence` is **not** used: creating a Habit is not checking it in, and no anchor date should advance. Recurrence is optional and not required by V1.

## Publishable model definition / Console 模型定义

Once this Core Capability has been deployed, a normal user-defined model can be published through Console with the following Model Definition JSON. This does not automatically make Habit a repository-shipped Baseline Model; that remains a separate governed decision.

```json
{
  "definitionVersion": 1,
  "key": "habit",
  "description": "A durable practice with explicit check-in facts and a Core-computed streak. Use for habits, not one-off Tasks or recurring reminders.",
  "display": {
    "singular": "Habit",
    "plural": "Habits"
  },
  "fields": {
    "name": {
      "type": "string",
      "title": "Name",
      "required": true,
      "minLength": 1,
      "maxLength": 150
    },
    "description": {
      "type": "text",
      "title": "Description",
      "nullable": true,
      "maxLength": 3000
    },
    "intervalDays": {
      "type": "integer",
      "title": "Check-in Interval (days)",
      "required": true,
      "immutable": true,
      "minimum": 1,
      "maximum": 365
    },
    "lastCheckInDate": {
      "type": "date",
      "title": "Last Check-in Date",
      "readOnly": true,
      "nullable": true
    },
    "streakStartDate": {
      "type": "date",
      "title": "Streak Start Date",
      "readOnly": true,
      "nullable": true
    }
  },
  "defaults": {
    "intervalDays": 1
  },
  "referenceLabel": {
    "field": "name"
  },
  "query": {
    "searchable": [
      "name",
      "description"
    ],
    "filterable": [
      "intervalDays"
    ],
    "sortable": [
      "name"
    ]
  },
  "access": [
    "read",
    "write"
  ],
  "lifecycle": {
    "optimisticConcurrency": true,
    "softDelete": true
  },
  "capabilities": {
    "checkIn": {
      "intervalDaysField": "intervalDays",
      "lastCheckInDateField": "lastCheckInDate",
      "streakStartDateField": "streakStartDate"
    }
  },
  "semanticRelations": {
    "outgoing": [
      "relates_to"
    ]
  }
}
```

## Lifecycle and Person ownership / 生命周期与人物归属（schema 72）

The repository-shipped Habit baseline is defined only in `apps/core/model-catalog/baseline-models.json`. The older generic three-binding JSON shown above is a minimal example of Check-in configuration, **not** the current full Habit baseline schema.

- `subjectPersonId: person` identifies exactly one Space Person and is required and immutable. A normally authorized user can create a Habit for another family member. Once created, `policies.update` and `policies.delete` limit mutations to a non-null authenticated `principal.personId` equal to `record.subjectPersonId`. The pause/resume/end/reopen Actions also enforce their own matching owner Policy.
- When an authorized User delegates to an Agent, Core derives Principal and Actor from verified credentials and delegation; the Agent does not gain the authority of an unrelated Person. A Person not linked to an authenticated User cannot perform Check-in.
- Lifecycle states: `active`, `paused`, `ended`; only `active` allows Check-in. The `status` field is initialized by Core and is only changed by named Actions. `capabilities.checkIn.statusField` / `allowedStatuses` are optional backward-compatible capability bindings for the reusable engine.
- Pausing does not create or alter check-in occurrences; the existing calendar-day streak semantics remain unchanged rather than freezing streak time.
- The schema 72 migration intentionally **fails closed if preexisting Habit records exist**, because a historical owner must never be guessed from the record creator. An owner-approved backfill and controlled migration are required before applying schema 72 in any environment containing existing Habit records.

## Semantics / 行为

- Create a Habit with a name, optional description, and immutable positive `intervalDays`. Both Core-owned date fields start at null; the computed streak is **0**. A user cannot set these fields via CRUD.
- Call `POST /api/v1/spaces/{spaceId}/models/habit/records/{recordId}/actions/check-in` with `{ "version": <currentRecordVersion> }`. The current **Space-local calendar date** is authoritative; clients cannot set an arbitrary check-in date.
- Every successful new-day check-in updates the two managed dates and inserts one auditable history fact in the same guarded D1 batch. If the Habit is already checked in today, return the existing record without incrementing version or writing another history row.
- The greatest permitted calendar-day gap between valid check-ins is `intervalDays`. When the gap is exceeded, the previous streak is broken and the next check-in starts a new streak at 1.
- `computed.checkIn.streakDays` counts the calendar-day span from the start of the current intact run **through the last actually recorded check-in date** (inclusive); it is not the number of check-ins. It does not increase merely because time passes. The run is shown as 0 once the last check-in is older than the permitted gap; no daily reset task runs.
- For example, with `intervalDays = 2`, check-ins on Oct 18 and Oct 20 yield **3 streak calendar days** and **2 actual check-ins**.
- Each Habit is currently treated as one check-in series. Shared/group habits requiring separate per-Person check-ins or interval revisions are not part of V1.

## Read and history / 查询

A normal authorized Record GET or List includes:

```json
{"computed":{"checkIn":{"today":"2026-10-20","streakDays":3,"checkedInToday":true}}}
```

Read the bounded history via `GET /api/v1/spaces/{spaceId}/models/habit/records/{recordId}/check-ins?limit=100&cursor=...`. Response includes `data.items` and `data.nextCursor`. Creation has **no** initial history entry.

## Authority, consistency, performance / 权限与性能

- The existing scoped Model write authorization and governed Action path are mandatory for check-in. Record read authorization and Policy checks protect history. All checks must be evaluated with current Space/app/Grant/delegation state.
- Read-only state fields cannot be changed through ordinary create/update or non-Capability actions. A record-version guard ensures that an overlapping update cannot corrupt the streak; the history row has a unique key on `(record_id,checked_on)`.
- Query/list streak projection reads the already available resource fields and one Space timezone context, not the entire history. History uses a bounded composite index and cursor pagination.
- No arbitrary backdating, undoing, editing history, changing the interval after creation, automatic Tasks or extra frontend-side streak calculations in V1.

Tracking: [Issue #388](https://github.com/huangshirui/LifeSpace/issues/388). This document is not evidence of a staging/production deployment.

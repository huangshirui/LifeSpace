# Generic Consumer Performance Feasibility Gate

Status: **M0-B passed with bounded conditions**  
Date: **2026-09-07**  
Owning issue: **#165 — Generic Consumer Readiness v1**  
Evidence PR: **#167 — [P0] Prove #165 M0-B performance feasibility**  
Authoritative CI run for this evidence: **Check #1154 / run 34045882637**

## 1. Purpose

M0-B exists to answer one question before any formal Runtime redesign:

> Can LifeSpace become self-describing and progressively consumable without introducing unbounded Core request cost or forcing ordinary Runtime traffic to pay for Discovery/Reference projection it did not request?

This gate is intentionally evidence-only. It does **not** change Runtime semantics, authorization, storage, contracts, Discovery output, Relation Target behavior or caching policy.

The gate distinguishes two cost classes that must not be conflated:

1. **Core execution cost** — HTTP/D1 request shape, database round trips, N+1 behavior, pagination and serialization work;
2. **consumer/context cost** — how much semantic DTO/tool/schema material an Adapter or Agent chooses to carry into one protocol exchange or LLM context.

Core owns bounded platform cost. Adapters/Product Runtime own tool-count and LLM-token economy.

## 2. Measurement environment and interpretation

The benchmark runs through the real Core application in Cloudflare Vitest with local D1 bindings and current-main semantics.

The local wall-time figures are **diagnostic only**. They are useful for detecting growth shape and obvious CPU/serialization regressions, but they are not APAC production latency evidence.

Absolute deployed latency continues to use the controlled APAC method documented in `docs/performance-invariants.md`, where the existing ordinary Runtime gate already passed representative common reads at P50 44–92 ms and P90 57–111 ms.

## 3. Current-main measurements

### 3.1 Cross-Space Runtime Discovery

`GET /api/v1/me/_discovery` was measured across representative `Space × Model` cardinalities.

| Scenario | Materialized Model DTOs | D1 round trips | Serialized bytes | Local P50 | Local P90 |
|---|---:|---:|---:|---:|---:|
| 1 Space × 1 Model | 1 | 2 | 3,053 | 14 ms | 32 ms |
| 4 Spaces × 2 Models | 8 | 2 | 24,929 | 8 ms | 9 ms |
| 8 Spaces × 4 Models | 32 | 2 | 99,205 | 9 ms | 15 ms |
| 16 Spaces × 4 Models | 64 | 2 | 198,433 | 13 ms | 17 ms |
| 32 Spaces × 4 Models | 128 | 2 | 396,865 | 14 ms | 17 ms |

Observed request-shape fact:

> Current aggregate Discovery performs **2 Worker→D1 round trips**, independent of `Space × Model` cardinality in these scenarios.

The two current round trips are:

1. published Model Registry read;
2. current authority/context query batch.

This corrects an earlier source-level assumption that aggregate Discovery would be one D1 round trip because the authority path itself uses one `DB.batch()`.

### 3.2 Single-Space Runtime Discovery

For one Space with all four currently published ordinary models:

- Model DTOs: **4**
- D1 round trips: **2**
- serialized bytes: **12,406**
- diagnostic local P50/P90: **6 / 7 ms**

### 3.3 Delegated-Agent Runtime Discovery

Representative delegated-Agent `/me/_discovery`:

- Model DTOs: **2**
- D1 round trips: **2**
- serialized bytes: **5,710**
- diagnostic local P50/P90: **9 / 14 ms**

Delegation changes the current authority statement set inside the existing bounded request shape; it does not add a new Worker→D1 waterfall in the measured path.

### 3.4 Relation Target Lookup

Person Relation Target Lookup was measured with 250 seeded targets.

| Page size | D1 round trips | Serialized bytes |
|---|---:|---:|
| `limit=1` | 2 | 408 |
| `limit=100` | 2 | 6,322 |

The D1 round-trip count is constant across these page sizes. The endpoint remains page-bounded and does not perform per-item D1 resolution.

### 3.5 Ordinary Runtime does not pay mandatory projection tax

A normal Task list request was measured before and after an explicit Discovery call.

- before Discovery: **2 D1 round trips**
- after Discovery: **2 D1 round trips**
- `ΔD1 = 0`
- `ΔHTTP = 0`

Therefore current Generic Consumer projection work is opt-in: ordinary CRUD/query execution does not require a Discovery or Reference projection preflight.

## 4. Main finding: I/O is bounded; aggregate payload is not a suitable default consumer context

M0-B proves two different facts at the same time.

### 4.1 Positive result — Core request shape is feasible

The measured paths do not show the failure modes that would block the architecture outright:

- Discovery D1 network round trips do not grow with `Space × Model` cardinality in the measured scenarios;
- Relation Target Lookup round trips do not grow with page result count;
- delegated-Agent Discovery stays within the same bounded network shape;
- ordinary Runtime traffic does not acquire hidden Discovery/Reference HTTP or D1 work;
- existing Phase-3 Runtime round-trip budgets remain intact.

This is sufficient evidence that a self-describing Core can be implemented without inherently turning every business request into a metadata/request waterfall.

### 4.2 Limiting result — full aggregate Discovery scales approximately with `Space × Model` materialization

The serialized aggregate Discovery payload grows from roughly **3 KB for 1 DTO** to roughly **397 KB for 128 DTOs**. The dominant growth dimension is DTO materialization/serialization/payload, not additional D1 network round trips.

Therefore the current aggregate `/me/_discovery` response is valid as an explicit complete projection, but it must **not** become the mandatory first step or default context representation for every MCP/Agent/n8n/ALOHA interaction.

`Discoverable` is not equivalent to `always injected`.

## 5. M0-B gate decision

Decision: **GO, with architectural constraints.**

Formal Runtime convergence may proceed only under the following shape:

```text
compact current capability inventory
  -> choose relevant Space/model/capability
  -> load detailed semantic projection only when needed
  -> resolve dynamic relation/reference context only when needed
  -> execute through normal Runtime
```

The gate explicitly rejects these designs:

- requiring full `/me/_discovery` before ordinary CRUD/query/action execution;
- injecting the complete Model/Action/Capability universe into every LLM context;
- generating all possible MCP/OpenAI Tools for every interaction regardless of local task;
- per-record/per-ID reference hydration that creates N+1 D1 I/O;
- request waterfalls that split already-batchable current authority/projection reads into serial network calls;
- distributed cache/TTL/push-invalidation infrastructure introduced before profiling proves a need.

## 6. What this gate does not prove

M0-B does **not** claim that the existing aggregate Discovery endpoint is the final progressive API shape.

It also does not prove:

- exact MCP/OpenAI Tool token counts;
- exact LLM prompt-token savings from top-K/virtual tool selection;
- production APAC latency for new projection endpoints that do not exist yet;
- the final Reference Resolution contract;
- the final compact capability inventory schema;
- a need for shared/distributed metadata cache infrastructure.

Those belong to the downstream #165 audit/gap-closure stages and Adapter acceptance evidence.

## 7. Performance invariants for subsequent #165 work

Any M1–M4 implementation should preserve these invariants mechanically where applicable:

1. ordinary hot business requests do not gain mandatory Discovery/Reference preflight calls;
2. projection/list D1 round trips remain O(1) in returned record/item count unless an explicitly documented bounded exception exists;
3. dynamic authority is evaluated from current state and is not replaced by cached Discovery as proof;
4. candidate/reference result sets are bounded by pagination and batch limits;
5. stable semantic compilation/caching is separated from mutable authority;
6. complete semantic availability is progressive rather than synonymous with complete-context injection;
7. absolute deployed latency claims use the controlled APAC measurement method, not GitHub/Vitest local wall time.

## 8. Verification evidence

The evidence harness is `apps/core/test/generic-consumer-performance-feasibility.integration.test.ts`.

Authoritative PR CI evidence for the recorded measurements:

- workflow: `Check`
- run number: **1154**
- run ID: **34045882637**
- result: **success**
- Core tests: **55 test files / 181 tests passed**
- full repository `pnpm check`: **passed**

The benchmark output is emitted as `M0B_PERFORMANCE_FEASIBILITY` in CI so later sessions can recover the raw measurement snapshot without relying on chat history.

## 9. Next step

M0-B is a gate, not a Runtime implementation milestone.

After this evidence is merged, #165 may continue into the formal current-main matrices/audits. The next implementation changes must be justified by gaps those audits prove, with progressive projection treated as a requirement and the above cost invariants preserved.

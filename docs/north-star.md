# LifeSpace North Star

Status: **Evolving strategic direction**  
Updated: **2026-08-26**

## Purpose

This document captures the long-term direction that should guide LifeSpace when current product needs, protocols, AI frameworks, infrastructure choices and implementation details pull in different directions.

It is intentionally more durable and more abstract than `docs/architecture.md`.

- `north-star.md` asks **what LifeSpace should become and why**.
- `architecture.md` defines **the current target architecture and normative implementation boundaries**.
- contracts, policies, migrations and source code define **what is supported now**.

The North Star is not immutable doctrine. It is expected to evolve as the AI era, product experience and our understanding of the problem evolve. Changes should be deliberate, explicit and recorded rather than emerging accidentally from a local implementation decision.

## 2026-08-26 refinement

Earlier framing described LifeSpace primarily as a durable digital reality composed of `Reality / Semantics / Authority / Agency / Context / History`. That was directionally useful but mixed durable subject matter, mechanisms and runtime projections at the same conceptual level.

Scenario review across traditional applications, Agents, family schedules, sports records, external systems, automation, preferences, conflicting sources and cross-Space sharing produced a more stable hierarchy:

```text
SPACE
├── Shared Reality
│   ├── Shared World
│   └── Shared Knowledge
├── Authority
└── Change
```

`Shared Reality` is the durable subject matter LifeSpace preserves. `Authority` governs who may know, decide or change it. `Change` governs how it is altered reliably.

`Semantics` is the mechanism that makes those concepts structured, meaningful and computable. `Context` is an authorized and relevant projection assembled for a particular consumer and task. `History` and provenance are cross-cutting properties required to understand important Reality and Change over time.

A second refinement makes the identity/operation model explicit. A **Principal** is an authenticated/authorizable security subject. Concrete principal types may include `User`, `Agent`, `Service`, `Device` and future explicitly modeled security identities. A registered **Application** is a separate product/client context and is not automatically a Principal. Within a particular operation, roles such as `actor`, `executor` and `delegator/on-behalf-of` reference Principals; `application context` references the registered Application.

This refinement does not invalidate the current Model Registry, Generic Runtime, typed persistence, Identity, Space/Data Grant, Capability, Eventing or deployed user/service/device-principal architecture. It clarifies how current security vocabulary relates to the longer-term Agent model without turning a current implementation detail into the whole ontology.

## Core thesis

> **LifeSpace gives any Space a durable shared digital reality and governed way to act on it, surviving changes in applications, Agents, models and protocols.**

LifeSpace is not fundamentally a personal-data platform or a family-data platform. Personal and family Spaces are initial proving contexts. A Space may represent a person, family, team, class, school, organization, project, home, vehicle, trip, community, temporary event, Agent collective or another bounded world not yet anticipated.

Applications and Agents are consumers and actors over this shared reality. They are not its owners merely because they provide the current interface or intelligence.

## Durable assumptions

LifeSpace should be designed under assumptions more durable than today's software stack:

- applications and user interfaces are replaceable;
- AI models, Agent frameworks and reasoning systems are replaceable;
- protocols such as REST, MCP, tool schemas and future Agent protocols are adapters, not domain truth;
- traditional Web, Mini Program and mobile experiences will coexist with Agent-driven experiences for a long time;
- human and non-human actors will both participate in digital systems;
- more information will be extracted, interpreted or inferred rather than entered only through structured forms;
- external systems will continue to own important sources of truth;
- shared state, shared knowledge, authority, provenance and meaningful change must survive replacement of applications and intelligence providers.

The strongest underlying assumption is simpler: some part of a Space's digital reality must remain useful across changes in application, intelligence provider, protocol and time. If that ceases to be true, the reason for LifeSpace itself disappears.

Therefore LifeSpace should be **Agent-ready but AI-independent**. AI should be able to understand, discover and operate LifeSpace easily, while LifeSpace itself must remain coherent without a particular model provider, prompt format, Agent framework or protocol.

## Space is a durable boundary

A **Space** is not merely a SaaS tenant, workspace or database partition. It is the durable boundary within which participants share a digital reality, authority over it and permitted ways to change it.

The long-term boundary rule is:

> **Spaces are isolated by default; cross-Space sharing must be explicit, bounded and revocable.**

Sharing must not silently merge two Spaces, move the authoritative source record, or create a second competing source of truth. A record or durable knowledge item should retain a clear source Space even when another Space or Principal receives an authorized view or capability over it.

The current one-source-Space record rule and Data Grant architecture are concrete foundations for this direction. Future richer cross-Space views or knowledge sharing should extend the same boundary rather than weakening it.

## Shared Reality

**Shared Reality answers: what durable digital reality should authorized participants continue to share and rely on?**

Shared Reality contains two distinct but related forms:

```text
Shared Reality
├── Shared World
└── Shared Knowledge
```

This distinction is semantic, not a requirement for two databases or two universal Kernel tables.

### Shared World

**Shared World answers: what world are participants jointly operating on?**

It includes durable domain records, entities, relationships, state, occurrences, plans and commitments that should continue to exist when a particular UI or Agent disappears.

Examples include people, events, tasks, goals, match records, trips, assets and relationships between them.

A traditional UI and an Agent must operate on the same World object. A football match entered through a Mini Program form and the same match created by an Agent acting for a user should result in the same domain record type, subject to the same authorization, semantics and validation. LifeSpace must not create separate "AI data" and "application data" worlds.

Shared World does not mean metaphysically perfect or infallible truth. A record may later be corrected. Provenance, history and source quality explain why the platform currently represents the world in a particular way.

The current metadata-driven ordinary Model system is an important way to structure Shared World. The North Star does **not** require replacing relational storage with a graph database, RDF, a universal entity table or another speculative persistence model.

### Shared Knowledge

**Shared Knowledge answers: what should participants continue to know, assert, conclude or remember about the shared world?**

Examples may include:

- explicit user or Space preferences;
- standing rules and conventions;
- important observations;
- durable assessments or conclusions that affect later decisions;
- assertions whose source matters;
- selected derived knowledge whose long-term value justifies persistence.

Shared Knowledge is not simply "uncertain data", while Shared World is not simply "certain data". The distinction is closer to:

- **World** — structured representation of entities, relationships, occurrences, commitments and state;
- **Knowledge** — durable cognition about that world: observations, assertions, interpretations, preferences, rules and assessments.

Observation, Claim, Assessment and similar concepts are possible semantic forms of Shared Knowledge, not a mandate to create AI-specific Kernel tables.

Not everything useful to an Agent belongs here. Agent working context, scratch reasoning, temporary conversation summaries and Agent-specific interaction heuristics are normally local to the Agent/runtime.

A useful promotion test is:

1. If the current Agent or application were replaced, should this information still exist?
2. Should another authorized application, person or Agent reasonably be able to rely on it?
3. Is it likely to influence future state, decisions, policy or action?

If the answer is no, it normally belongs in Agent-local memory, current task state or another replaceable layer rather than LifeSpace Shared Knowledge.

## Authority

**Authority answers: which Principals have what authority, within which Space/context, and how may authority be delegated or combined for an operation?**

The important questions include:

- which Principal or Principals participate;
- what authority each Principal owns directly;
- whether one Principal is acting under authority delegated by another;
- who initiated the operation and who actually executes it;
- within which Space;
- under which Application context;
- for what purpose;
- within what capability and data boundary;
- under what constraints and expiry;
- whether consent or approval is required.

### Principal is the security-subject abstraction

A Principal is an identity that can be authenticated, authorized, granted capability and audited.

The long-term type family may include, without implying a permanently closed list:

```text
Principal
├── User
├── Agent
├── Service
├── Device
└── future explicitly modeled security-principal types
```

The current Core already implements concrete `user`, `service` and `device` principal types. First-class Agent principal semantics are a future extension, not an implemented claim.

A registered Application is deliberately separate:

```text
Application
  = registered product/client/integration context
  = application identity/configuration/scope ceiling
  ≠ automatically a Principal
```

If an application needs independent runtime authority, LifeSpace should represent that through an explicit Principal associated with the application, such as a Service principal or a future deliberately defined application-principal type, rather than silently treating every Application registration as an acting security subject.

### Operation roles reference Principals

A particular operation can involve several roles:

```text
Operation / Change
├── actor               -> Principal that caused/initiated the operation
├── executor            -> Principal that executes it, when distinct
├── delegator/onBehalfOf-> Principal whose authority is delegated, when applicable
└── applicationContext  -> Application through which the operation occurs
```

These are **roles in an operation**, not sibling Principal types.

Examples:

```text
Direct user action:
  actor              = User: usr_123
  executor           = User: usr_123
  applicationContext = HomeMew

Delegated Agent action:
  actor              = Agent: aloha-agent
  delegator          = User: usr_123
  delegation         = usr_123 -> aloha-agent, bounded scope/Space/time
  applicationContext = ALOHA

Platform-admin action:
  actor              = User: usr_admin
  executor           = Service: console-core-executor
  authority          = intersection of human admin proof and executor capability
  applicationContext = LifeSpace Console
```

An operation therefore does not need to pretend there is always exactly one meaningful Principal. Authority may be direct, delegated or an intersection of multiple independently verified Principals.

> **An Agent may be a first-class Principal and Actor, but Principal status does not imply User-equivalent authority. Authority is always explicit and bounded.**

An Agent may act with its own granted authority, with delegated user/Space authority, or with a combination permitted by policy. It must never infer durable authorization from Agent memory alone.

Global Identity, Space membership, Data Grants, Application × Model Access, credential scope and current model policy are the existing foundation. Future Agent delegation, consent and approval should extend that foundation rather than bypass it.

Authorization is durable platform state, not Agent memory.

## Change

**Change answers: how may Shared Reality be altered reliably?**

CRUD remains useful and should continue to work for traditional software, but CRUD is the simplest transport/execution form of a more general concept: an authorized change to Shared World or Shared Knowledge.

A simple edit may reduce to:

```text
Action -> Authority Check -> Commit
```

A complex or higher-risk Agent operation may require:

```text
Intent -> Proposal/Plan -> Validation -> Approval -> Commit
```

Long-term concepts may include Action, Intent, Proposal, Change/ChangeSet, validation, risk, approval, commit and compensation. These are not requirements to route every edit through a heavyweight workflow. Simple changes must remain simple while autonomous or high-impact changes can receive stronger controls when concrete cases justify them.

Reasoning systems may choose or propose changes. LifeSpace determines whether the participating Principals, delegation chain, Application context and current policy authorize the operation, then performs the durable commit under deterministic platform rules where possible.

## Semantics is a mechanism, not another Reality category

LifeSpace needs machine-readable meaning so that humans, traditional applications and Agents can operate on the same Shared Reality.

The semantic system may include:

- Model and schema definitions;
- concepts and relations;
- capability definitions;
- constraints and validation;
- policy semantics;
- lifecycle and temporal semantics.

The current Model Registry and Model Definitions are therefore not obsolete. They are foundational mechanisms for defining Shared World and, where appropriate, Shared Knowledge.

REST paths, MCP tools, OpenAI tool schemas, SDKs, n8n nodes, generated forms and future protocols should be projections/adapters over stable semantics rather than becoming the semantic source of truth.

## Context is a projection, not the database

LifeSpace should not become a giant Agent context store.

For a particular task, Agent context is conceptually assembled from:

```text
relevant authorized LifeSpace Shared Reality
+
Agent-local memory
+
current conversation/task state
+
live external context
```

LifeSpace may eventually provide Context Projection capabilities that select the correct authorized, relevant and timely slice for the relevant Principals, delegation, task and moment.

That projection is a runtime result. It should not imply that prompts, intermediate reasoning, embeddings, conversations or scratch memory become permanent LifeSpace data.

## Attribution, provenance and history are cross-cutting

A durable shared reality must explain important state and changes when attribution or provenance matters.

A domain record may be created through a Web form, Mini Program, Agent acting for a user, service integration, external authoritative system or AI extraction. These are different entry paths into the same domain model, not different data models.

Keep **operation attribution** separate from **information provenance**.

Operation attribution may include:

```text
actor              = Principal that caused/initiated the operation
executor           = Principal that executed it, if distinct
delegator/onBehalfOf = Principal whose authority was delegated, if applicable
applicationContext = Application through which it occurred
```

Information provenance may include:

```text
source      = where the information originated
sourceRef   = reference to original material/system
derivedFrom = inputs used to derive information
```

They may be recorded together in audit/history envelopes where useful, but they answer different questions and must not be treated as one flat type hierarchy.

Information quality should not be determined merely by "human vs AI". A user statement entered through an Agent may be a direct user assertion, while an AI-generated conclusion from video may be inference. The underlying source and derivation matter.

History, events, audit and provenance should allow meaningful questions such as "what changed?", "who caused it?", "which Principals authorized/executed it?" and, where important, "why do we believe this?".

## LifeSpace is not the universal source of truth

LifeSpace must not become a central copy of every external system.

For each external information domain, choose deliberately among four relationships:

- **Own** — LifeSpace is the authoritative owner of the shared representation.
- **Mirror** — another system is authoritative; LifeSpace persists an appropriate synchronized representation.
- **Reference** — LifeSpace keeps identity/metadata/linkage while the original data remains elsewhere.
- **Query** — data remains external and is fetched when needed rather than persisted as durable LifeSpace state.

The goal is not to ingest all reality. It is to maintain the portion of a Space's digital reality and knowledge that multiple authorized participants need to share and rely on.

## Traditional software and Agents must share the same platform

LifeSpace is not an AI-only architecture.

Traditional Mini Programs, Web Apps and mobile clients should remain able to use familiar query, CRUD and Action APIs without understanding Agent-specific concepts.

Different consumers may use different projections of the same platform:

```text
Traditional UI -> Query / CRUD / Actions
Automation      -> Events / Actions / service authority
Agent           -> Discovery / Context / Capabilities / own or delegated authority
```

They must converge on the same Shared Reality, Authority and Change semantics.

A useful compatibility test for a new abstraction is:

1. Can a normal Web/Mini Program client use the underlying capability without becoming an Agent system?
2. Can an Agent use the same domain capability without bypassing authorization, semantics or audit?

If only one side works, the abstraction is probably either over-AI-specific or too tightly coupled to traditional UI/API assumptions.

## Relationship to orchestration and intelligence

LifeSpace should keep these responsibilities separate:

```text
Application / generated UI = Experience
Agent / model              = Reasoning
n8n / workflow systems     = Orchestration
LifeSpace                  = Shared Reality + Authority + Change
```

LifeSpace may integrate deeply with orchestration and Agent systems, but it should not become a competing workflow builder, reasoning framework or model runtime.

## Replaceability test

For every long-lived platform abstraction or durable state, ask:

> **If the current application, Agent, AI model, orchestration system or protocol disappeared, would this concept and its durable state still make sense?**

LifeSpace should remain coherent if HomeMew, ALOHA, n8n, MCP, a model vendor or another current integration is removed or replaced.

Apply the test in reverse as well: if a concept is useful only inside one Agent's reasoning process, one UI flow or one protocol, it probably belongs in that replaceable layer rather than the LifeSpace Kernel.

## Architecture lens for new platform work

For each new platform abstraction, persistent state or contract, classify it first as one or more of:

- **Shared World** — durable domain entity, relationship, state, occurrence, plan or commitment;
- **Shared Knowledge** — durable cross-application/Agent knowledge, rule, preference, observation, assertion or assessment worth sharing;
- **Authority** — Principal identity, permission, grant, delegation, consent or approval;
- **Change** — intent, action, proposal, commit, compensation or change history;
- **Semantics** — model/schema/capability/constraint/policy mechanism that defines the above;
- **Context Projection** — runtime selection of relevant authorized information for a consumer/task;
- **Adapter** — protocol, external-system or transport integration;
- **Experience** — product/UI behavior for a particular audience.

Then ask:

1. Does this information need to survive replacement of the current App or Agent?
2. Should another authorized consumer be able to rely on it?
3. Is it Shared World, Shared Knowledge, or merely transient Agent/task context?
4. Does durable data belong to LifeSpace, or should the external system remain authoritative under Own/Mirror/Reference/Query?
5. Are application-created and Agent-created records converging on the same domain model?
6. Is a current protocol/vendor/framework being promoted into durable truth?
7. Is Space isolation preserved and cross-Space sharing explicit, bounded and revocable?
8. Are Principal types, operation roles and Application context kept distinct?
9. Can an autonomous change identify actor, executor and delegation/authority chain where they differ?
10. Does an Agent receive only explicit own/delegated authority rather than User-equivalent authority by implication?
11. Are we exposing only CRUD where a stable semantic Action/Change is the better abstraction, while still allowing simple CRUD to stay simple?
12. Is a proposed Kernel abstraction genuinely universal, or a product/personal/family/organization assumption?
13. Are we prematurely generalizing an implementation instead of preserving an extension point until concrete cases justify it?

A conflict with this North Star must be surfaced explicitly. Do not silently redefine the platform through a local feature implementation.

## Anti-goals

LifeSpace should not drift into being merely:

- a generic CRUD backend;
- a database shared by several frontends;
- an AI-only data platform;
- a giant Agent memory/context store;
- a universal knowledge graph or graph database project;
- a central Data Lake copying every external source of truth;
- a personal-only or family-only data platform;
- a traditional SaaS tenant/workspace abstraction;
- an MCP server with storage behind it;
- an Agent framework or reasoning runtime;
- a prompt/model runtime;
- a workflow/orchestration product competing with systems such as n8n;
- a no-code application builder;
- a universal schemaless JSON store;
- a system where application-specific or Agent-specific copies become parallel sources of truth;
- a system where inferred information is silently treated as direct/authoritative information when the distinction matters;
- a system where broad service credentials substitute for bounded authority;
- a system where registered Application context is silently treated as an acting Principal without an explicit security identity;
- a system where all Principal types are assumed to have equivalent authority;
- a system where an Agent gains User-equivalent authority merely because it is capable of acting.

These anti-goals do not prohibit integrations or adapters. They prohibit making a replaceable layer the conceptual center of LifeSpace.

## Relationship to current architecture

Current Identity, Space/Data Grant, metadata-driven Model Registry/Generic Runtime, typed persistence, Capabilities, Eventing, contracts and service boundaries are valuable foundations and remain the current architecture.

They map naturally toward the refined North Star:

```text
ordinary Models / records         -> Shared World
future durable shared cognition   -> Shared Knowledge
Identity / Principal / Space/Grant-> Authority
current user/service/device types  -> current Principal implementations
CRUD / Capabilities               -> simple forms of Change
Eventing / audit                  -> Change/history plumbing
Model Registry / definitions      -> Semantics
registered Applications / azp     -> Application context + authority ceiling
```

Current identifiers and contract names such as `service principal`, `principal_type`, `$actor` and platform-admin `actor proof` remain valid implementation vocabulary. The conceptual refinement does not require renaming deployed APIs. It clarifies the distinctions that future delegation/Agent work must preserve.

Future work may add richer provenance, shared preferences/rules/knowledge, first-class Agent Principals/delegation, semantic Change/ChangeSet, approval and Context Projection when concrete product or platform needs justify them.

This document does **not** declare Observation, Claim, Agent Principal, Context, graph storage, Agent memory or other speculative concepts as already implemented Kernel features.

The North Star is a compass for choosing direction, not a backlog requiring speculative implementation.

## Evolution policy

This document should evolve deliberately.

A North Star change is appropriate when new evidence changes our view of the durable problem, not merely because a new framework or protocol becomes popular.

When changing it:

1. state what assumption or long-term conclusion changed;
2. explain why the previous framing is insufficient;
3. describe consequences for current architecture, if any;
4. distinguish immediate architecture work from longer-term possibility;
5. record the decision in the engineering log;
6. avoid retroactively claiming that speculative future concepts are already implemented.

The goal is not to predict 2036 perfectly. The goal is to keep today's engineering decisions from unnecessarily closing off the most plausible durable future.
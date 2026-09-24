# LifeSpace North Star

Status: **Evolving strategic direction**  
Updated: **2026-08-26**

## Purpose

This document captures the long-term direction that should guide LifeSpace when current product needs, protocols, AI frameworks, infrastructure choices and implementation details pull in different directions.

It is intentionally more durable and more abstract than `docs/architecture.md`.

- `north-star.md` asks **what LifeSpace should become and why**.
- `architecture.md` defines **the current target architecture and normative implementation boundaries**.
- contracts, policies, migrations and source code define **what is supported now**.

The North Star is not immutable doctrine. It should evolve only when new evidence changes the durable problem framing, not merely because a current product, protocol, model provider or implementation changes.

## 2026-08-26 axiomatic refinement

Earlier versions moved from `Reality / Semantics / Authority / Agency / Context / History` toward `Shared World / Shared Knowledge / Authority / Change`. Scenario review across traditional applications, Agent interaction, family schedules, sports records, external systems, automation, preferences, conflicting sources and cross-Space sharing showed that the direction was sound but the conceptual levels were still mixed.

The refined framing is:

```text
SPACE
├── Shared Reality
│   ├── Shared World
│   └── Shared Knowledge
├── Authority
└── Change
```

`Shared Reality` is what persists. `Authority` governs who may know, decide or act. `Change` governs how durable reality may be altered. `Semantics` makes these concepts structured and computable. `Context` is a runtime projection. `History` and provenance are cross-cutting evidence about durable reality and change.

This refinement does not declare new speculative Kernel tables and does not invalidate the current Model Registry, Generic Runtime, typed persistence, Identity, Space/Data Grant, Capability, Eventing or service-authentication architecture.

## Core thesis

> **LifeSpace gives any Space a durable shared digital reality and governed action foundation that survives replacement of applications, Agents, models, protocols and orchestration systems.**

LifeSpace is not fundamentally a personal-data platform or family-data platform. Personal and family scenarios are initial proving contexts. A Space may represent a person, family, team, class, school, organization, project, home, vehicle, trip, community, temporary event, Agent collective or another bounded world not yet anticipated.

Applications and Agents are participants, consumers and possible actors over this shared reality. They are not its owners merely because they provide the current interface or intelligence.

## Foundational assumptions

The North Star depends on a smaller set of assumptions than any particular ten-year technology forecast.

### H1 — Applications are replaceable

Current Web, Mini Program, mobile, generated-UI and future application experiences will change. Durable shared state must not belong conceptually to the current interface.

### H2 — Intelligence is replaceable

AI models, Agent frameworks, reasoning systems and model providers will change repeatedly. Durable platform meaning and authority must not depend on one intelligence implementation.

### H3 — Protocols are replaceable

REST, MCP, tool schemas, SDKs, workflow adapters and future Agent protocols are adapters over stable platform meaning, not the source of domain truth.

### H4 — Multiple participants and authoritative sources will continue to exist

People, Agents, applications, services and external systems will coexist. Important truth will remain federated across LifeSpace and external authoritative systems rather than collapsing into one universal database.

### H5 — Some shared reality must outlive the current participant, application and interaction

Certain state and knowledge must remain available across applications, Agents and time to future authorized participants. If nothing needed to survive those replacements, there would be little reason for LifeSpace to exist as a platform.

These are foundational assumptions. Other expectations — for example that interfaces become more generated, people express more intent through natural language, or inferred information becomes more common — are useful planning expectations but are not required for the LifeSpace thesis to remain coherent.

Therefore LifeSpace should be **Agent-ready but AI-independent**.

## Core axioms

The following axioms are intended to be a minimal durable set. Architecture may evolve, but a design that contradicts one of these must surface the conflict explicitly.

### A1 — Space Boundary

> **All durable shared reality exists within an explicit Space boundary. Spaces are isolated by default; cross-Space sharing must be explicit, bounded and revocable.**

A Space is not merely a SaaS tenant, workspace or `space_id` isolation trick. It is the durable boundary for shared reality and authority.

Cross-Space sharing does not merge Spaces, move ownership or create a second authoritative copy. Data Grants and future approved sharing constructs express bounded relationships across otherwise distinct Spaces.

### A2 — Durable Shared Reality

> **LifeSpace persists the part of a Space's digital reality that should remain meaningful and useful after the current application, Agent or protocol disappears.**

Shared Reality has two non-interchangeable forms:

```text
Shared Reality
├── Shared World
└── Shared Knowledge
```

Shared World represents the structured world participants jointly operate on. Shared Knowledge represents durable knowledge about that world that future authorized participants should reasonably be able to rely on.

Agent scratch reasoning, temporary conversation state, UI state and interaction-specific memory are not automatically Shared Reality.

### A3 — Bounded Authority

> **Every participant acts only through explicit, bounded authority. Identity type and operation role are separate concepts, and the Principal whose authority is used must be distinguishable from the Actor that executes an operation when they differ.**

Humans, Agents, applications and services may all be identifiable and auditable entities. They are not therefore naturally equal in authority.

An Agent is a first-class possible Actor, not automatically a User and not automatically entitled to a user's authority. It may act under delegated user authority or, where deliberately granted, under its own bounded authority.

### A4 — Governed Change

> **Every durable alteration to Shared Reality is a Change performed under Authority, semantic constraints and the risk controls appropriate to that operation.**

CRUD remains a useful simple execution form. It is not the conceptual center of the platform.

A simple operation may reduce to:

```text
Action -> Authority Check -> Commit
```

A higher-risk autonomous operation may require:

```text
Intent -> Proposal/Plan -> Validation -> Approval -> Commit
```

Simple changes must remain simple; the model must nevertheless support stronger controls for autonomous, high-impact or reversible/compensatable change.

### A5 — Federated Truth

> **LifeSpace does not own all truth. For external information, its relationship to the authoritative source must be deliberate.**

The stable relationship vocabulary is:

- **Own** — LifeSpace is authoritative for the shared representation.
- **Mirror** — another system is authoritative; LifeSpace keeps an appropriate synchronized representation.
- **Reference** — LifeSpace keeps identity, metadata or linkage while the original content remains elsewhere.
- **Query** — data remains external and is fetched when needed rather than persisted as durable LifeSpace state.

LifeSpace must not drift into a central Data Lake that copies the whole external world.

## Enduring responsibilities

The axioms lead to three top-level long-lived responsibilities inside each Space.

### Shared Reality

**Shared Reality answers: what durable digital reality can authorized participants jointly rely on?**

#### Shared World

**Shared World answers: what world are participants jointly operating on?**

It includes durable domain entities, relationships, state, occurrences, plans and commitments. Examples include people, events, tasks, goals, match records, trips, assets and relationships between them.

A traditional UI and an Agent operate on the same World object. A football match entered through a Mini Program form and the same match created by an Agent acting for the user must become the same domain record type under the same authorization and validation rules. LifeSpace must not create separate "AI data" and "application data" worlds.

Shared World does not mean infallible objective truth. A record may later be corrected. Where material, provenance and history explain how a state was asserted, derived and changed.

The current metadata-driven ordinary Model system is an important semantic and execution mechanism for Shared World. The North Star does **not** require graph storage, RDF, a universal entity table or another speculative persistence model.

#### Shared Knowledge

**Shared Knowledge answers: what should participants continue to know about the shared world?**

Examples may include:

- explicit user or Space preferences;
- standing rules and conventions;
- important observations;
- durable assessments or conclusions that affect later decisions;
- relevant assertions whose source matters;
- selected derived knowledge whose long-term value justifies persistence.

World and Knowledge are not distinguished as "true" versus "uncertain". World is the structured representation of state/occurrence/commitment; Knowledge is durable cognition, assertion, interpretation, rule or assessment about that world.

Observation, Claim, Assessment and similar concepts are possible semantic forms of Shared Knowledge, not a mandate to create AI-specific Kernel tables.

A useful promotion test is:

1. If the current Agent were replaced, should this information still exist?
2. Should another authorized application or Agent be able to rely on it?
3. Is it likely to influence future state, decisions, policy or action?

If not, it normally belongs in Agent-local memory, current conversation/task state or another replaceable runtime layer rather than LifeSpace Shared Knowledge.

### Authority

**Authority answers: who may know, decide or change what, under whose authority and within what boundary?**

Long-lived Authority concerns include identity, Space membership, Data Grants, application/model access, delegation, consent, approval, credential scope, constraints and expiry.

Authorization is durable platform state, not Agent memory.

#### Entity type and operation role are orthogonal

Do not model `Principal` as a parent type whose children are `User / Agent / Application / Service` merely because all of those entities may participate in authorization.

Conceptually, identifiable/authority-capable entities may include:

```text
Entity
├── User
├── Agent
├── Application
└── Service
```

An operation then assigns roles to entities and context:

```text
Operation / Change
├── principal           = whose authority is being exercised
├── actor               = who/what actually executes or initiates the operation
└── applicationContext  = through which application context the operation occurs
```

The same entity may fill more than one role. For a direct user action, `principal == actor`. For a delegated Agent action, the user may be the Principal while the Agent is the Actor. An Agent may also be both Principal and Actor if it has explicitly granted independent authority.

`Application` as an entity and `applicationContext` as an operation role/context are related but not the same conceptual level.

Current contracts or implementations may continue to use `principal` as an established authentication/credential label. Such implementation vocabulary must not erase the conceptual distinction between **entity type** and **operation role**.

### Change

**Change answers: how may Shared Reality be altered reliably?**

Reasoning systems may choose or propose changes. LifeSpace determines whether the relevant authority exists and commits durable changes under deterministic platform rules where possible.

Long-term concepts may include Action, Intent, Proposal, Change/ChangeSet, validation, risk, approval, commit and compensation. These are not requirements to route every edit through a heavyweight workflow.

## Semantics is a mechanism, not another kind of reality

LifeSpace needs machine-readable meaning so that humans, traditional applications and Agents can operate on the same Shared Reality.

The semantic system may include:

- Model and schema definitions;
- concepts and relations;
- capability definitions;
- constraints and validation;
- policy semantics;
- lifecycle and temporal semantics.

The current Model Registry and Model Definitions are foundational semantic mechanisms for defining Shared World and, where appropriate, Shared Knowledge.

REST paths, MCP tools, OpenAI tool schemas, SDKs, workflow adapters, generated forms and future protocols should be projections/adapters over stable semantics rather than becoming the semantic source of truth.

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

LifeSpace may provide Context Projection capabilities that select the correct authorized, relevant and timely slice for an entity, role, task and moment.

That projection is a runtime result. It does not imply that prompts, intermediate reasoning, embeddings, conversations, scratch memory or every external observation become permanent LifeSpace data.

## Attribution, provenance and history are cross-cutting

A shared digital reality must be able to explain important state and changes when attribution or provenance matters.

Keep two related but distinct groups clear.

### Operation attribution

```text
principal           = whose authority was exercised
actor               = who/what executed or initiated the operation
applicationContext  = through which application context it occurred
```

### Information provenance

```text
source       = where the information originated
sourceRef    = reference to original material/system
derivedFrom  = inputs used to derive information
```

A domain record may be created through a Web form, Mini Program, Agent acting for a user, service integration, external authoritative system or AI extraction. These are different entry paths into the same Shared World/Knowledge semantics, not different domain worlds.

Information quality should not be determined merely by "human vs AI". A user assertion relayed through an Agent may be direct user evidence, while an AI conclusion from video may be an inference. Source and derivation matter.

History, events, audit, attribution and provenance should support meaningful questions such as: what changed, who caused it, under whose authority, through which application context and, where important, why do we believe it?

## Traditional software and Agents share one platform

LifeSpace is not an AI-only architecture.

Traditional Mini Programs, Web Apps and mobile clients should remain able to use familiar query, CRUD and Action APIs without understanding Agent-specific concepts.

Different consumers may use different projections:

```text
Traditional UI -> Query / CRUD / Actions
Automation      -> Events / Actions / service authority
Agent           -> Discovery / Context / Capabilities / delegated authority
```

They converge on the same Shared Reality, Authority and Change semantics.

A useful compatibility test for a new abstraction is:

1. Can a normal Web/Mini Program client use the underlying capability without becoming an Agent system?
2. Can an Agent use the same domain capability without bypassing authorization, semantics or audit?

If only one side works, the abstraction is probably either over-AI-specific or too tightly coupled to traditional UI/API assumptions.

## Relationship to orchestration and intelligence

LifeSpace keeps these responsibilities separate:

```text
Application / generated UI = Experience
Agent / model               = Reasoning
workflow systems            = Orchestration
LifeSpace                   = Shared Reality + Authority + Change
```

LifeSpace may integrate deeply with orchestration and Agent systems, but it should not become a competing workflow builder, reasoning framework or model runtime.

## Replaceability test

For every long-lived platform abstraction or durable state, ask:

> **If the current application, Agent, AI model, orchestration system or protocol disappeared, would this concept and its durable state still make sense?**

Apply the test in reverse as well: if a concept is useful only inside one Agent's reasoning process, one UI flow or one protocol, it probably belongs in that replaceable layer rather than the LifeSpace Kernel.

## Architecture lens for new platform work

For each new platform abstraction, persistent state or contract, first classify it as one or more of:

- **Shared World** — durable domain entity, relationship, state, occurrence, plan or commitment;
- **Shared Knowledge** — durable cross-application/Agent knowledge, rule, preference, assertion, observation or assessment worth sharing;
- **Authority** — identity, permission, grant, delegation, consent or approval;
- **Change** — intent, action, proposal, validation, commit, compensation or change history;
- **Semantics** — model/schema/capability/constraint/policy mechanism defining the above;
- **Context Projection** — runtime selection of relevant authorized information;
- **Adapter** — protocol, external-system or transport integration;
- **Experience** — application/UI behavior for a particular audience.

Then ask:

1. Which foundational assumption and axiom justify this abstraction?
2. Does it need to survive replacement of the current App or Agent?
3. Should another authorized consumer be able to rely on it?
4. Is it Shared World/Knowledge or merely transient Agent/UI context?
5. Does durable data belong to LifeSpace under Own, or should an external system remain authoritative under Mirror/Reference/Query?
6. Are application-created and Agent-created records converging on the same domain model?
7. Is a current protocol/vendor/framework being promoted into durable truth?
8. Are Principal, Actor and application context correctly distinguished for autonomous or delegated change?
9. Are we exposing only CRUD where a stable semantic Action/Change is the better abstraction while still allowing simple CRUD to stay simple?
10. Is a proposed Kernel abstraction genuinely universal, or a product/personal/family/organization assumption?
11. Are we prematurely generalizing an implementation instead of preserving an extension point until concrete cases justify it?

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
- a workflow/orchestration product;
- a no-code application builder;
- a universal schemaless JSON store;
- a system where application-specific or Agent-specific copies become parallel sources of truth;
- a system where inferred information is silently treated as direct/authoritative information when the distinction matters;
- a system where broad service credentials substitute for bounded authority;
- a system where being an Actor silently grants the Authority of another Principal.

These anti-goals do not prohibit integrations or adapters. They prohibit making a replaceable layer the conceptual center of LifeSpace.

## Relationship to current architecture

Current Identity, Space/Data Grant, metadata-driven Model Registry/Generic Runtime, typed persistence, Capabilities, Eventing, contracts and service boundaries remain valuable foundations.

They map naturally toward the refined North Star:

```text
Space / source ownership           -> Space Boundary
ordinary Models / records          -> Shared World
future durable rules/assessments   -> Shared Knowledge where justified
Identity / Membership / Grant      -> Authority foundation
CRUD / Capabilities / Workflow     -> simple forms of Change
Model Registry / definitions       -> Semantics
Eventing / audit                    -> Change/history plumbing
external integrations              -> Own/Mirror/Reference/Query adapters
```

Current authentication implementations may call a normalized authenticated identity a `principal` or use names such as `service principal`. Those deployed labels remain valid implementation vocabulary. Future conceptual design must nevertheless distinguish entity type from the Principal/Actor roles of an operation rather than assuming `Principal -> User | Agent | Application | Service` is the ontology.

Future work may add richer durable Shared Knowledge, delegated Agent authority, semantic Change/ChangeSet, approval and Context Projection when concrete product or platform needs justify them.

This document does **not** declare Observation, Claim, Context, graph storage, Agent memory, universal Actor tables or other speculative concepts as already implemented Kernel features.

The North Star is a compass for choosing direction, not a backlog requiring speculative implementation.

## Evolution policy

A North Star change is appropriate when new evidence changes our view of the durable problem, not merely because a framework or protocol becomes popular.

When changing it:

1. state which foundational assumption, axiom or long-term conclusion changed;
2. explain why the previous framing is insufficient;
3. describe consequences for current architecture, if any;
4. distinguish immediate architecture work from longer-term possibility;
5. record the decision in the engineering log;
6. avoid retroactively claiming that speculative future concepts are already implemented.

The goal is not to predict 2036 perfectly. The goal is to keep today's engineering decisions from unnecessarily closing off the durable platform we are trying to build.

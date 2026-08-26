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

The previous North Star described LifeSpace primarily as a durable digital reality composed of `Reality / Semantics / Authority / Agency / Context / History`. That framing was directionally useful but mixed together durable things, explanatory mechanisms and runtime projections at the same conceptual level.

Scenario-based review across traditional applications, Agent interaction, family schedules, sports records, external systems, automation, preferences and conflicting sources led to a more stable framing:

> **LifeSpace is the long-lived digital world and action foundation that people, applications and AI Agents within a Space can jointly rely on.**

Its enduring responsibilities are:

```text
SPACE
├── Shared World
├── Shared Knowledge
├── Authority
└── Change
```

`Semantics` is the mechanism that makes those concepts structured, meaningful and computable. `Context` is an authorized and relevant projection assembled for a particular consumer and task. `History` and provenance are cross-cutting properties required to understand important World, Knowledge and Change over time.

This refinement does not invalidate the current Model Registry, Generic Runtime, typed persistence, Identity, Space/Data Grant, Capability or Eventing architecture. It clarifies what those mechanisms should ultimately serve.

## Core thesis

> **LifeSpace gives any Space a durable shared digital world that survives changes in applications, Agents, models and protocols.**

LifeSpace is not fundamentally a personal-data platform or a family-data platform. Personal and family Spaces are initial proving contexts. A Space may represent a person, family, team, class, school, organization, project, home, vehicle, trip, community, temporary event, Agent collective or another bounded world not yet anticipated.

A **Space（空间）** is therefore not merely a SaaS tenant, workspace or data-isolation container. It is a durable boundary within which participants can share a digital representation of a world, shared knowledge about that world, authority over it and permitted ways to change it.

Applications and Agents are consumers and actors over this shared world. They are not its owners.

### Space boundary and cross-Space sharing

> **Space defines the boundary of a shared world; Grants define how that world crosses boundaries.**  
> **空间（Space）定义共享世界的边界；授权（Grant）定义世界如何跨越边界。**

Isolation is the default. A fact, record or durable knowledge item has an authoritative/source Space unless a more specific external-authority relationship is explicitly modeled. Another Space does not gain visibility or mutation authority merely because the same person, application or Agent participates in both Spaces.

Cross-Space use must therefore be explicit through an authorized mechanism such as a Data Grant, approved reference or derived view. Sharing is not equivalent to copying:

- sharing must not silently create a second authoritative fact;
- sharing must not silently move the authoritative/source Space;
- a consuming Space may receive visibility or bounded capability while the original authority remains intact;
- provenance and source ownership must remain recoverable when information crosses a Space boundary.

This principle applies beyond ordinary records. Durable Shared Knowledge, future semantic Actions and other LifeSpace concepts should preserve the same distinction between **where authority originates** and **where authorized consumers may use it**.

### Principals and Agents

LifeSpace must treat non-human participants as first-class without pretending that they are human users.

A **Principal（主体）** is an entity that can be identified and participate in authorization. A **User（用户）**, **Agent（智能体）**, **Application（应用）** or **Service（服务）** may be represented as distinct kinds of principal when the architecture requires it.

> **Agents are first-class actors, but not human users. They may act under their own authority or on behalf of another principal.**  
> **智能体（Agent）是一等行为参与者，但不是人类用户（User）；它既可以依据自身授权行动，也可以代表其他主体（Principal）行动。**

An Agent therefore must not be collapsed into either of these shortcuts:

- silently impersonating a human user for every operation; or
- becoming an unconstrained backend service account whose authority is detached from people, Spaces and purpose.

Where the distinction matters, LifeSpace should be able to preserve:

```text
principal      = whose authority/assertion is represented
actor          = who/what actually executed the operation
onBehalfOf     = optional principal being represented
application    = application context through which it occurred
authority      = grant/delegation/consent/policy that allowed it
source         = where the information or action originated
```

A user-directed Agent action may therefore have an Agent as **Actor（行为主体）** and a user as **On-behalf-of Principal（被代表主体）**. An autonomous Agent may instead act under an explicit Grant or other durable authority assigned to the Agent itself. The authorization and provenance model must preserve that difference rather than relying on Agent-local memory.

This is a long-term semantic direction. It does not declare that every principal type, Agent registration flow or delegation contract is already implemented.

## Ten-year assumptions

LifeSpace should be designed under assumptions more durable than today's software stack:

- application interfaces will become increasingly adaptive, generated and replaceable;
- traditional Web, Mini Program and mobile experiences will continue to coexist with Agent-driven experiences for a long time;
- AI models, Agent frameworks and reasoning systems will change repeatedly;
- protocols such as REST, MCP, tool schemas and future Agent protocols are adapters, not domain truth;
- people will increasingly express intent while software and Agents plan and execute changes;
- non-human actors will become normal participants in digital systems;
- much more information will be extracted, interpreted or inferred rather than entered directly through structured forms;
- trustworthy automation will become more valuable than merely capable automation;
- external systems will continue to own important sources of truth; LifeSpace must interoperate with them without trying to copy the whole world;
- shared state, knowledge, authority, provenance and meaningful change must survive replacement of applications and intelligence providers.

Therefore LifeSpace should be **Agent-ready but AI-independent**. AI should be able to understand, discover and operate LifeSpace easily, while LifeSpace itself must remain coherent without a particular model provider, prompt format, Agent framework or protocol.

## The four enduring responsibilities

### Shared World

**Shared World answers: what world are participants jointly operating on?**

It includes durable domain records, entities, relationships, state, occurrences, plans and commitments that should continue to exist when a particular UI or Agent disappears.

Examples include people, Spaces, events, tasks, goals, match records, trips, assets and relationships between them.

A traditional UI and an Agent must operate on the same World object. For example, a football match entered through a Mini Program form and the same match created by an Agent acting for the user must result in the same domain record type, subject to the same authorization and validation rules. LifeSpace must not create separate "AI data" and "application data" worlds.

The current metadata-driven ordinary Model system is an important way to structure Shared World. The North Star does **not** require replacing relational storage with a graph database, RDF, a universal entity table or another speculative persistence model.

### Shared Knowledge

**Shared Knowledge answers: what should participants continue to know about the shared world?**

Not everything useful to an Agent belongs here. Agent working context, scratch reasoning, temporary conversation summaries and Agent-specific interaction heuristics are normally local to the Agent/runtime.

Information belongs in Shared Knowledge when it has durable, cross-application or cross-Agent value and an authorized future consumer should reasonably be able to rely on it.

Examples may include:

- explicit user or Space preferences;
- standing rules and conventions;
- important observations;
- durable assessments or conclusions that affect later decisions;
- relevant assertions whose source matters;
- provenance about where important information came from;
- selected derived knowledge whose long-term value justifies persistence.

Observation, Claim, Assessment and similar concepts are **possible semantic forms of Shared Knowledge**, not a mandate to create AI-specific Kernel tables. A statement produced during reasoning may remain temporary; only information with durable shared value should be promoted into LifeSpace.

A useful promotion test is:

1. If the current Agent were replaced, should this information still exist?
2. Should another authorized application or Agent be able to rely on it?
3. Is it likely to influence future state, decisions, policy or action?

If the answer is no, it normally belongs in Agent context or Agent-local memory rather than LifeSpace.

### Authority

**Authority answers: who may know, decide or change what?**

The important question in an Agent world is not only "who are you?" but also:

- whom are you acting for;
- within which Space;
- under which application or service context;
- for what purpose;
- under what delegation or consent;
- within what capability and data boundary;
- under what constraints and expiry;
- whether approval is required.

Global Identity, Space membership, Data Grants, Application × Model Access, credential scope and current model policy are the existing foundation.

Future delegated Agent authority, consent and approval should extend that foundation rather than allowing each Agent to remember or invent its own permission boundary. Authorization is durable platform state, not Agent memory.

### Change

**Change answers: how may the shared world be altered reliably?**

CRUD remains useful and should continue to work for traditional software, but CRUD is the simplest transport/execution form of a more general concept: an authorized change to Shared World or Shared Knowledge.

A simple user edit may reduce to:

```text
Action -> Authority Check -> Commit
```

A complex or higher-risk Agent operation may require:

```text
Intent -> Proposal/Plan -> Validation -> Approval -> Commit
```

Long-term concepts may include Action, Intent, Proposal, Change/ChangeSet, validation, risk, approval, commit and compensation. These are not requirements to route every edit through a heavyweight workflow. The model must allow simple changes to remain simple while giving autonomous or high-impact changes stronger controls when needed.

Reasoning systems may choose or propose changes. LifeSpace determines whether the current actor is authorized and performs the durable commit under deterministic platform rules where possible.

## Semantics is a mechanism, not a fifth world

LifeSpace needs machine-readable meaning so that humans, traditional applications and Agents can operate on the same world.

The semantic system may include:

- Model and schema definitions;
- concepts and relations;
- capability definitions;
- constraints and validation;
- policy semantics;
- lifecycle and temporal semantics.

The current Model Registry and Model Definitions are therefore not obsolete. They are a foundational semantic mechanism for defining Shared World and, where appropriate, Shared Knowledge.

REST paths, MCP tools, OpenAI tool schemas, SDKs, n8n nodes, generated forms and future protocols should be projections/adapters over stable semantics rather than becoming the semantic source of truth.

## Context is a projection, not the database

LifeSpace should not become a giant Agent context store.

For a particular task, the final context available to an Agent is conceptually:

```text
Agent Context
=
relevant authorized LifeSpace Shared World
+
relevant authorized LifeSpace Shared Knowledge
+
Agent-local memory
+
current conversation/task state
+
live external context
```

LifeSpace may eventually provide Context Projection capabilities that select the correct authorized, relevant and timely slice of the shared world for a principal, intent and moment.

That projection is a runtime result. It should not imply that all Agent context, prompts, intermediate reasoning, embeddings, conversations or scratch memory become permanent LifeSpace data.

## Provenance and history are cross-cutting

A shared digital world must be able to explain important state and changes when provenance matters.

A domain record may be created through a Web form, Mini Program, Agent acting for a user, service integration, external authoritative system or AI extraction. These are different entry paths into the same World model, not different data models.

Where relevant, LifeSpace should preserve distinctions such as:

```text
principal     = whose authority or assertion is represented
actor         = who/what executed the operation
onBehalfOf    = optional principal being represented
application   = through which application context
source        = where the information originated
sourceRef     = reference to original material/system
derivedFrom   = inputs used to derive information
```

Information quality should not be determined merely by "human vs AI". A user statement entered through an Agent may be a direct user assertion, while an AI-generated conclusion from video may be inference. The underlying source and derivation matter.

History, events, audit and provenance should allow meaningful questions such as "what changed?", "who caused it?", "under whose authority?", "on whose behalf?" and, where important, "why do we believe this?".

## LifeSpace is not the universal source of truth

LifeSpace must not become a central copy of every external system.

For each external information domain, choose deliberately among four relationships:

- **Own** — LifeSpace is the authoritative owner of the shared representation.
- **Mirror** — another system is authoritative; LifeSpace persists an appropriate synchronized representation.
- **Reference** — LifeSpace keeps identity/metadata/linkage while the original data remains elsewhere.
- **Query** — data remains external and is fetched when needed rather than persisted as durable LifeSpace state.

Examples might include a LifeSpace-owned family task, a mirrored bank-bill summary, a referenced large video, or queried live weather.

The goal is not to ingest all reality. It is to maintain the portion of a Space's digital world and knowledge that multiple participants need to share and rely on.

## Traditional software and Agents must share the same platform

LifeSpace is not an AI-only architecture.

Traditional Mini Programs, Web Apps and mobile clients should remain able to use familiar query, CRUD and Action APIs without understanding Agent-specific concepts.

Different consumers may use different projections of the same platform:

```text
Traditional UI -> Query / CRUD / Actions
Automation      -> Events / Actions / service authority
Agent           -> Discovery / Context / Capabilities / delegated authority
```

They must converge on the same Shared World, Shared Knowledge, Authority and Change semantics.

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
LifeSpace                  = Shared World + Shared Knowledge + Authority + Change
```

LifeSpace may integrate deeply with orchestration and Agent systems, but it should not become a competing workflow builder, reasoning framework or model runtime.

## Replaceability test

For every long-lived platform abstraction or durable state, ask:

> **If the current application, Agent, AI model, orchestration system or protocol disappeared, would this concept and its durable state still make sense?**

LifeSpace should remain coherent if HomeMew, ALOHA, n8n, MCP, a model vendor or another current integration is removed or replaced.

This test should also be applied in reverse: if a concept is useful only inside one Agent's reasoning process, one UI flow or one protocol, it probably belongs in that replaceable layer rather than the LifeSpace Kernel.

## Architecture lens for new platform work

For each new platform abstraction, persistent state or contract, first classify the durable concern as one or more of:

- **Shared World（共享世界）** — durable domain entity, relationship, state, occurrence, plan or commitment shared within a Space;
- **Shared Knowledge（共享知识）** — durable cross-application/Agent knowledge, rule, preference, observation, assertion, assessment or provenance that is worth sharing;
- **Authority（权威/授权）** — identity, permission, grant, delegation, consent or approval;
- **Change（变化）** — intent, action, proposal, commit, compensation or change history;
- **Semantics（语义）** — model/schema/capability/constraint/policy mechanism that defines the above;
- **Context Projection（上下文投影）** — runtime selection of relevant authorized information for a consumer/task;
- **Adapter（适配器）** — protocol, external-system or transport integration;
- **Experience（体验）** — product/UI behavior for a particular audience.

Then ask:

1. Does this information need to survive replacement of the current App or Agent?
2. Should another authorized consumer be able to rely on it?
3. Are we modeling a shared world/knowledge concept, or merely preserving transient Agent context?
4. Does durable data belong to LifeSpace, or should the external system remain authoritative under Own/Mirror/Reference/Query?
5. Are application-created and Agent-created records converging on the same domain model?
6. Is a current protocol/vendor/framework being promoted into durable truth?
7. Can an autonomous change be attributed to the relevant principal, actor, application/delegation and source?
8. Are we exposing only CRUD where a stable semantic Action/Change is the better abstraction, while still allowing simple CRUD to stay simple?
9. Is a proposed Kernel abstraction genuinely universal, or a product/personal/family/organization assumption?
10. Are we prematurely generalizing an implementation instead of preserving an extension point until concrete cases justify it?
11. What is the authoritative/source Space for this durable fact or knowledge item, and is any cross-Space use explicit rather than copied?
12. If an Agent acts, is it acting under its own authority or on behalf of another principal, and can that distinction be authorized and audited?

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
- a system where cross-Space sharing silently creates a second authoritative copy;
- a system where inferred information is silently treated as direct/authoritative information when the distinction matters;
- a system where broad service credentials substitute for bounded authority;
- a system where Agents silently impersonate users or accumulate broad authority without durable grants/delegation and attribution.

These anti-goals do not prohibit integrations or adapters. They prohibit making a replaceable layer the conceptual center of LifeSpace.

## Relationship to current architecture

Current Identity, Space/Data Grant, metadata-driven Model Registry/Generic Runtime, typed persistence, Capabilities, Eventing, contracts and service boundaries are valuable foundations and remain the current architecture.

They map naturally toward the refined North Star:

```text
Identity / Space / Grant          -> Authority
ordinary Models / records         -> Shared World
Model Registry / definitions      -> Semantics
CRUD / Capabilities               -> simple forms of Change
Eventing / audit                  -> Change/history plumbing
service/user principals           -> actors under Authority
```

Future work may add richer provenance, shared preferences/rules/knowledge, explicit Agent principals, delegated authority, semantic Change/ChangeSet, approval and Context Projection when concrete product or platform needs justify them.

This document does **not** declare Observation, Claim, Context, graph storage, Agent memory, universal Agent registration or delegation contracts as already implemented Kernel features.

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
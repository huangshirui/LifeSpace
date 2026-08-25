# LifeSpace North Star

Status: **Evolving strategic direction**  
Updated: **2026-08-25**

## Purpose

This document captures the long-term direction that should guide LifeSpace when current product needs, protocols, AI frameworks, infrastructure choices and implementation details pull in different directions.

It is intentionally more durable and more abstract than `docs/architecture.md`.

- `north-star.md` asks **what LifeSpace should become and why**.
- `architecture.md` defines **the current target architecture and normative implementation boundaries**.
- contracts, policies, migrations and source code define **what is supported now**.

The North Star is not immutable doctrine. It is expected to evolve as the AI era, product experience and our understanding of the problem evolve. Changes should be deliberate, explicit and recorded rather than emerging accidentally from a local implementation decision.

## Core thesis

> **LifeSpace gives any Space a durable digital reality.**

LifeSpace is not fundamentally a personal-data platform or a family-data platform. Personal and family Spaces are initial proving contexts. The platform should remain capable of representing any bounded world that needs durable state, semantics, authority, agency, context and history: a person, family, team, class, school, organization, project, home, vehicle, trip, community, temporary event, agent collective or a future Space type not yet anticipated.

A **Space** is therefore not merely a SaaS tenant, workspace or data-isolation container. It is a bounded digital world with participants, things, relationships, state, rules, history and permitted ways to change that world.

## Ten-year assumptions

LifeSpace should be designed under several assumptions that are more durable than today's software stack:

- application interfaces will become increasingly adaptive, generated and replaceable;
- AI models, Agent frameworks and reasoning systems will change repeatedly;
- protocols such as REST, MCP, tool schemas and future Agent protocols are adapters, not domain truth;
- people will increasingly express intent while software and Agents plan and execute changes;
- non-human actors will become normal participants in digital systems;
- much more data will be interpreted or inferred by AI rather than entered directly into structured forms;
- trustworthy automation will become more valuable than merely capable automation;
- durable world state, meaning, authority, provenance and history must survive changes in applications and intelligence providers.

Therefore LifeSpace should be **Agent-ready but AI-independent**. AI should be able to understand, discover and operate LifeSpace easily, while LifeSpace itself must not depend on a particular model provider, prompt format, Agent framework or protocol to remain coherent.

## The enduring layers of a Space

The long-term conceptual model is:

```text
SPACE
├── Reality
├── Semantics
├── Authority
├── Agency
├── Context
└── History
```

These are directional concepts, not a mandate to create six immediate subsystems.

### Space

Space is the primary world boundary. It should not encode personal, family, organization or other product-specific assumptions in the Kernel unless they are genuinely universal platform invariants.

A Space may be long-lived or temporary, human-centered or object/project-centered, and may relate to other Spaces. The platform must not assume all Spaces are flat, permanent, isolated tenants.

### Reality

LifeSpace represents the durable state of a world: entities, relationships, observations, claims, commitments and other facts meaningful inside a Space.

Applications should not own parallel authoritative copies of LifeSpace reality. An application is an experience and authority context over the world, not the owner of that world.

The long-term logical model may become richer than today's ordinary `Model` abstraction. This does **not** imply a graph database or any specific physical-storage technology. Logical world semantics and physical persistence should remain separable.

### Semantics

Agents and applications need to know not just field names and endpoints, but what concepts mean, how they relate, what capabilities exist and what constraints apply.

Stable semantic concepts should belong to LifeSpace. REST paths, MCP tools, OpenAI tool schemas, SDKs, n8n nodes and future protocols should be projections/adapters over those semantics rather than becoming the source of truth.

### Authority

The important question in an Agent world is not only "who are you?" but also:

- whom are you acting for;
- for what purpose;
- under what delegation;
- within what Space and capability boundary;
- under what constraints and expiry;
- whether human or multi-party approval is required.

Identity, Space membership, Grants and current authorization are the existing foundation. Future delegated Agent authority, consent and approval should extend that foundation rather than bypass it with broad permanent service authority.

### Agency

AI systems operate toward goals, not toward CRUD endpoints. LifeSpace should increasingly model meaningful actions and changes to a world rather than exposing only low-level record mutation.

Long-term concepts may include Action, Intent, Proposal, Change/ChangeSet, validation, risk, approval, commit and compensation. These should remain deterministic platform semantics where possible; Agent reasoning chooses or proposes actions, but platform rules determine whether and how world state can change.

### Context

A large durable world cannot be placed wholesale into an Agent context window. LifeSpace should eventually be able to project the correct authorized, relevant and timely slice of a Space for a given principal, intent and moment.

Context is therefore more than database query. It may incorporate authority, relationships, time, provenance, relevance and freshness while remaining separate from Agent reasoning itself.

### History

A trusted digital world needs to explain how it reached its current state.

History includes events, provenance, evidence, actor/delegation attribution, decisions and state evolution. Time should not be treated merely as a collection of timestamp fields.

AI-derived information makes provenance especially important. LifeSpace should preserve the distinction between, for example:

```text
observation -> interpretation -> claim -> confirmation -> authoritative state
```

The platform should be able to answer not only "what is the value?" but also, where important, "why do we believe this?" and "who or what caused this change?"

## Replaceability test

For long-lived platform abstractions, ask:

> **If the current application, Agent framework, AI model, orchestration system or protocol disappeared, would this concept and its durable state still make sense?**

LifeSpace should remain coherent if HomeMew, ALOHA, n8n, MCP, a model vendor or another current integration is removed or replaced.

Replaceable layers may depend on those technologies. Durable LifeSpace truth should not.

## Architecture lens for new platform work

Before introducing a new platform abstraction, persistent state, public contract or protocol dependency, classify the change primarily as one or more of:

- **Reality** — a durable concept/state in a Space;
- **Semantics** — meaning, relations, capabilities or constraints;
- **Authority** — identity, permission, delegation, consent or approval;
- **Agency** — intent, action or world change;
- **Context** — an authorized/relevant projection of the world;
- **History** — event, provenance, evidence or state evolution;
- **Adapter** — protocol, external-system or transport integration;
- **Experience** — product/UI behavior for a particular audience.

Then ask:

1. Are we modeling the real world or merely today's UI?
2. Does this state belong to a Space/world, or are we accidentally making it application-owned?
3. Is a current protocol or vendor being promoted into a durable domain abstraction?
4. Would the design survive replacement of the current App, Agent, AI model and protocol?
5. Are AI-derived claims distinguishable from authoritative facts where that distinction matters?
6. Can autonomous changes be attributed to the relevant principal, Agent/delegation and intent?
7. Are we exposing only CRUD where a stable semantic action/change is the real concept?
8. Are we preserving enough history and provenance to understand meaningful future decisions?
9. Is a proposed Kernel abstraction truly universal, or is it a family/personal/organization/product assumption?
10. Are we prematurely generalizing a temporary implementation instead of preserving a clean extension point?

A conflict with this North Star must be surfaced explicitly. Do not silently redefine the platform through a local feature implementation.

## Anti-goals

LifeSpace should not drift into being merely:

- a generic CRUD backend;
- a database shared by several frontends;
- a personal-only or family-only data platform;
- a traditional SaaS tenant/workspace abstraction;
- an MCP server with storage behind it;
- an Agent framework or reasoning runtime;
- a prompt/model runtime;
- a workflow/orchestration product competing with systems such as n8n;
- a no-code application builder;
- a universal schemaless JSON store;
- a system where application-specific copies become parallel sources of truth;
- a system where AI inference is indistinguishable from observed or confirmed reality;
- a system where broad service credentials substitute for bounded delegated authority.

These anti-goals do not prohibit integrations or adapters for these technologies. They prohibit making a replaceable layer the conceptual center of LifeSpace.

## Relationship to current architecture

Current Identity, Space/Data Grant, metadata-driven Model Registry/Generic Runtime, typed persistence, Capabilities, Eventing, contracts and service boundaries are valuable foundations because they already separate durable platform truth from application-specific implementation.

They are not assumed to be the final ten-year abstractions. In particular, future work may enrich today's concepts toward stronger world relations, provenance/evidence, semantic Action/Change, delegated authority, context projection and temporal history.

Such evolution should occur only when concrete needs justify it. The North Star is a compass for choosing direction, not a backlog requiring speculative implementation.

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
import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  for (const [from, to] of replacements) {
    if (!text.includes(from)) throw new Error(`Expected text not found in ${path}: ${from.slice(0, 100)}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(path, text);
}

patch("apps/core/AGENTS.md", [
  [
    "- model-agnostic Domain Event outbox state, application/Space/model-scoped event subscriptions, signed Webhook delivery, retry state and delivery diagnostics;",
    "- model-agnostic Domain Event outbox state, Space/subscriber-scoped Webhook Endpoints, model/event subscription filters, signed Webhook delivery, retry state and endpoint-level delivery diagnostics;",
  ],
  [
    "- event-subscription management is a user/Space-management operation: it requires `spaces:manage`, current Space `manage` permission and current read access to the selected model;\n- event delivery is reference-only and must not become a bypass around normal record-read authorization;",
    "- Webhook Endpoint management is a user/Space-management operation: it requires `spaces:manage` and current Space `manage` permission; creating an endpoint grants no model access;\n- adding/enabling/materially editing an Event Subscription filter additionally requires current managing-application read access and a current subscriber Data Grant for the selected model;\n- Webhook URL and signing secret belong to the Endpoint, never to an individual model subscription;\n- event delivery is reference-only and must not become a bypass around normal record-read authorization;",
  ],
  [
    "- Event outbox/subscription/delivery tables are explicit Kernel infrastructure, not ordinary business models.",
    "- Event outbox/Webhook Endpoint/subscription/delivery tables are explicit Kernel infrastructure, not ordinary business models.",
  ],
  ["current Kernel version: 0.14.0", "current Kernel version: 0.15.0"],
  [
    "- Eventing changes cover event generation, subscription filtering, signing, retry/idempotency and revocation behavior appropriate to the slice;",
    "- Eventing changes cover event generation, Endpoint transport/signing, subscription filtering, retry/idempotency and revocation behavior appropriate to the slice;",
  ],
]);

patch("docs/architecture.md", [
  [
    "- security/signing/deployment state.",
    "- Eventing Webhook Endpoint/subscription/delivery state;\n- security/signing/deployment state.",
  ],
  ["current Kernel contract: 0.13.0", "current Kernel contract: 0.15.0"],
]);

patch("docs/contracts.md", [
  [
    "1. **Kernel Contract** — explicit, code-owned APIs such as Space, Membership, Data Grant, Event Subscription, Registry-driven Creation Draft orchestration and service-only model administration.",
    "1. **Kernel Contract** — explicit, code-owned APIs such as Space, Membership, Data Grant, Webhook Endpoint/Event Subscription, Registry-driven Creation Draft orchestration and service-only model administration.",
  ],
  [
    "As of Core Kernel `0.14.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`. They exist only in a concrete immutable Model Contract Revision. CI rejects Event/Task/Day Record/Wish or generic `{modelRoute}` paths if they are reintroduced into the Kernel OpenAPI. Kernel `0.13.0` introduced whole-Space and published-model collection Data Grant targeting; Kernel `0.14.0` adds the model-agnostic Event Subscription/Webhook control surface without duplicating ordinary-model CRUD schemas into the Kernel contract.",
    "As of Core Kernel `0.15.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`. They exist only in a concrete immutable Model Contract Revision. CI rejects Event/Task/Day Record/Wish or generic `{modelRoute}` paths if they are reintroduced into the Kernel OpenAPI. Kernel `0.13.0` introduced whole-Space and published-model collection Data Grant targeting; Kernel `0.14.0` introduced model-agnostic Eventing; Kernel `0.15.0` separates reusable Webhook Endpoint transport/signing from model/event subscription filters so multiple models can share one callback and signing secret.",
  ],
  [
    "- Event Subscription lifecycle, signed Webhook test-send and delivery diagnostics;",
    "- Webhook Endpoint lifecycle, one-time signing-secret rotation, endpoint-level test/delivery diagnostics and attached Event Subscription filters;",
  ],
  [
    "Kernel 0.14.0 adds Event Subscription management as model-agnostic Kernel syntax. A subscription selects a published `modelKey` and generic `record.created` / `record.updated` / `record.deleted` event types, but it does not redefine that model's records. The Webhook payload is reference-only; consumers that need full record data must use the ordinary Model Contract route under their current service credential and Data Grant authority.",
    "Kernel 0.15.0 models Eventing as two Kernel resources. A Webhook Endpoint owns the Space/subscriber binding, callback URL and signing secret. Event Subscriptions attach one published `modelKey` plus generic `record.created` / `record.updated` / `record.deleted` filters to that endpoint. The Webhook payload remains reference-only; consumers that need full record data must use the ordinary Model Contract route under their current service credential and Data Grant authority. Endpoint creation itself grants no model authority; subscription creation/enabling requires current managing model access and current subscriber Data Grant access.",
  ],
  [
    "A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moved Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`; Kernel `0.13.0` added backwards-compatible model-collection Data Grant targeting for external integrations; Kernel `0.14.0` adds the generic Eventing subscription and Webhook-delivery management surface.",
    "A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moved Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`; Kernel `0.13.0` added backwards-compatible model-collection Data Grant targeting for external integrations; Kernel `0.14.0` introduced generic Eventing; Kernel `0.15.0` separates shared Webhook Endpoint transport/signing from model/event subscription filters.",
  ],
  [
    "- Eventing contract checks preserve model-agnostic event types, subscriber Service Principal binding and one-time signing-secret behavior without copying ordinary record schemas;",
    "- Eventing contract checks preserve model-agnostic event types, Endpoint/subscriber binding, shared one-time signing-secret behavior, model/event filter separation and reference-only payloads without copying ordinary record schemas;",
  ],
]);

console.log("Aligned Eventing architecture and contract documentation");

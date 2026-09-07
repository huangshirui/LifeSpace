import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const OLD_REF = "refs/remotes/origin/fix/109-eventing-contract-lifecycle";
const read = (path) => readFile(resolve(root, path), "utf8");
const write = (path, value) => writeFile(resolve(root, path), value, "utf8");

function fail(message) {
  throw new Error(`[finalize-eventing-after-94-95] ${message}`);
}

function replaceOnce(text, search, replacement, label) {
  if (!text.includes(search)) fail(`missing replacement anchor: ${label}`);
  return text.replace(search, replacement);
}

function showOld(path) {
  return execFileSync("git", ["show", `${OLD_REF}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
}

function operations(document) {
  const methods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
  const result = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const method of Object.keys(item)) {
      if (methods.has(method.toLowerCase())) result.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return [...new Set(result)].sort();
}

function operationDigest(document) {
  return `sha256:${createHash("sha256").update(operations(document).join("\n")).digest("hex")}`;
}

// Reuse the already-reviewed Eventing 0.1 wire contract/checker and downstream handoff logic.
for (const path of [
  "apps/core/integration-eventing.openapi.yaml",
  "apps/core/scripts/check-integration-eventing-openapi.mjs",
  "docs/contract-stability.md",
  "docs/eventing.md",
  "packages/contracts/README.md",
  "packages/contracts/scripts/check-homemew-candidate-handoff.mjs",
  "packages/contracts/scripts/check-homemew-handoff.mjs",
  "packages/contracts/scripts/export-homemew-handoff.mjs",
  "packages/contracts/scripts/export-homemew-staging-candidate.mjs",
]) {
  await write(path, showOld(path));
}

// The old PR accidentally duplicated one README bullet; normalize while rebasing.
let contractsReadme = await read("packages/contracts/README.md");
contractsReadme = contractsReadme.replace(
  "- `integration-eventing.openapi.yaml` when the accepted profile pins Eventing;\n- `integration-eventing.openapi.yaml` when the accepted profile pins Eventing;",
  "- `integration-eventing.openapi.yaml` when the accepted profile pins Eventing;",
);
contractsReadme = contractsReadme.replaceAll("Core 0.30.0 or later", "Core 0.31.0 or later");
await write("packages/contracts/README.md", contractsReadme);

const kernelPath = "apps/core/openapi.yaml";
const kernel = JSON.parse(await read(kernelPath));
if (kernel.info?.version !== "0.30.0") fail(`expected current Kernel 0.30.0, found ${kernel.info?.version}`);

const eventPaths = [
  "/api/v1/webhook-endpoints",
  "/api/v1/webhook-endpoints/{endpointId}",
  "/api/v1/webhook-endpoints/{endpointId}/deliveries",
  "/api/v1/webhook-endpoints/{endpointId}/test",
  "/api/v1/event-subscriptions",
  "/api/v1/event-subscriptions/{subscriptionId}",
];
for (const path of eventPaths) {
  if (!kernel.paths?.[path]) fail(`Kernel missing expected Eventing path ${path}`);
  delete kernel.paths[path];
}
for (const name of ["EventSubscriptionId", "WebhookEndpointId"]) delete kernel.components.parameters[name];
for (const name of [
  "DomainEventType",
  "WebhookDelivery",
  "WebhookDeliveryListResponse",
  "WebhookTestResponse",
  "WebhookDestination",
  "WebhookEndpoint",
  "CreateWebhookEndpointRequest",
  "UpdateWebhookEndpointRequest",
  "WebhookEndpointResponse",
  "CreateWebhookEndpointResponse",
  "UpdateWebhookEndpointResponse",
  "WebhookEndpointListResponse",
  "EventSubscription",
  "CreateEventSubscriptionRequest",
  "UpdateEventSubscriptionRequest",
  "EventSubscriptionResponse",
  "EventSubscriptionListResponse",
]) delete kernel.components.schemas[name];

kernel.info.version = "0.31.0";
kernel.info.description = String(kernel.info.description)
  .replace("webhook endpoints, event subscriptions, ", "")
  .replace("Webhook Endpoint/Event Subscription, ", "")
  .concat(" Integration/Eventing management and signed outbound Webhook representation are owned by the separately versioned apps/core/integration-eventing.openapi.yaml contract while remaining implemented by the same Core Worker.");
kernel.tags = (kernel.tags ?? []).filter((tag) => !["Webhook Endpoints", "Event Subscriptions"].includes(tag?.name));
kernel.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.31.0";
const kernelSerialized = JSON.stringify(kernel);
for (const path of eventPaths) if (kernelSerialized.includes(`\"${path}\"`)) fail(`Eventing path remains in Kernel: ${path}`);
await write(kernelPath, kernelSerialized);

const eventing = JSON.parse(await read("apps/core/integration-eventing.openapi.yaml"));
if (eventing.info?.version !== "0.1.0") fail("Integration/Eventing contract must remain 0.1.0");

const packageJson = JSON.parse(await read("apps/core/package.json"));
packageJson.version = "0.31.0";
packageJson.scripts.contract = "node scripts/check-openapi.mjs && node scripts/check-model-control-plane-openapi.mjs && node scripts/check-integration-eventing-openapi.mjs && node scripts/check-kernel-route-namespace.mjs && node scripts/check-platform-admin-openapi.mjs";
await write("apps/core/package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

let appTs = await read("apps/core/src/app.ts");
appTs = replaceOnce(appTs, 'contractVersion: "0.30.0"', 'contractVersion: "0.31.0"', "Core runtime contract version");
await write("apps/core/src/app.ts", appTs);

let checkKernel = await read("apps/core/scripts/check-openapi.mjs");
checkKernel = checkKernel.replaceAll('"0.30.0"', '"0.31.0"');
for (const line of [
  '  "/api/v1/webhook-endpoints",\n',
  '  "/api/v1/webhook-endpoints/{endpointId}",\n',
  '  "/api/v1/webhook-endpoints/{endpointId}/deliveries",\n',
  '  "/api/v1/webhook-endpoints/{endpointId}/test",\n',
  '  "/api/v1/event-subscriptions",\n',
  '  "/api/v1/event-subscriptions/{subscriptionId}",\n',
]) {
  checkKernel = replaceOnce(checkKernel, line, "", `remove Eventing required path ${line.trim()}`);
}
checkKernel = replaceOnce(
  checkKernel,
  'for (const path of Object.keys(document.paths ?? {})) {\n  if (path.startsWith("/api/v1/model-admin")) throw new Error(`Model Control Plane route leaked into Kernel OpenAPI: ${path}`);\n}\n',
  'for (const path of Object.keys(document.paths ?? {})) {\n  if (path.startsWith("/api/v1/model-admin")) throw new Error(`Model Control Plane route leaked into Kernel OpenAPI: ${path}`);\n  if (path === "/api/v1/webhook-endpoints" || path.startsWith("/api/v1/webhook-endpoints/")\n      || path === "/api/v1/event-subscriptions" || path.startsWith("/api/v1/event-subscriptions/")) {\n    throw new Error(`Integration/Eventing route leaked into Kernel OpenAPI: ${path}`);\n  }\n}\n',
  "Kernel Eventing route exclusion",
);
checkKernel = replaceOnce(
  checkKernel,
  'for (const name of Object.keys(schemas)) {\n  if (/^(Event|Task|DayRecord|Wish|CreationDraftEvent|CreationDraftTask|CreationDraftDayRecord|CreationDraftWish)/.test(name)\n      && !name.startsWith("EventSubscription")) {',
  'for (const name of Object.keys(schemas)) {\n  if (name === "DomainEventType" || name.startsWith("Webhook") || name.startsWith("EventSubscription")) {\n    throw new Error(`Integration/Eventing schema leaked into Kernel OpenAPI: ${name}`);\n  }\n  if (/^(Event|Task|DayRecord|Wish|CreationDraftEvent|CreationDraftTask|CreationDraftDayRecord|CreationDraftWish)/.test(name)) {',
  "Kernel Eventing schema exclusion",
);
checkKernel = replaceOnce(
  checkKernel,
  'for (const forbidden of ["Events", "Tasks", "Day Records", "Wishes"]) {',
  'for (const forbidden of ["Events", "Tasks", "Day Records", "Wishes", "Webhook Endpoints", "Event Subscriptions"]) {',
  "Kernel Eventing tag exclusion",
);
const eventingBlockStart = checkKernel.indexOf('const endpoints = document.paths?.["/api/v1/webhook-endpoints"]');
const creationDraftStart = checkKernel.indexOf('const creationDraft = document.paths?.["/api/v1/spaces/{spaceId}/creation-drafts"]?.post;');
if (eventingBlockStart < 0 || creationDraftStart < 0 || creationDraftStart <= eventingBlockStart) fail("cannot locate old Kernel Eventing checker block");
checkKernel = `${checkKernel.slice(0, eventingBlockStart)}${checkKernel.slice(creationDraftStart)}`;
await write("apps/core/scripts/check-openapi.mjs", checkKernel);

let rootAgents = await read("AGENTS.md");
rootAgents = replaceOnce(
  rootAgents,
  "- Core business-facing Kernel API: `apps/core/openapi.yaml`\n- Core Model Registry / Model Contract governance API: `apps/core/model-control-plane.openapi.yaml`",
  "- Core business-facing Kernel API: `apps/core/openapi.yaml`\n- Core Integration/Eventing API: `apps/core/integration-eventing.openapi.yaml`\n- Core Model Registry / Model Contract governance API: `apps/core/model-control-plane.openapi.yaml`",
  "root sources of truth Eventing contract",
);
rootAgents = replaceOnce(
  rootAgents,
  "Core Kernel:\n  apps/core/openapi.yaml\n\nCore Model Control Plane:",
  "Core Kernel:\n  apps/core/openapi.yaml\n\nCore Integration / Eventing:\n  apps/core/integration-eventing.openapi.yaml\n  independently versioned public companion contract; same Core Worker, separate compatibility lifecycle\n\nCore Model Control Plane:",
  "root contract workflow Eventing block",
);
await write("AGENTS.md", rootAgents);

let coreAgents = await read("apps/core/AGENTS.md");
coreAgents = replaceOnce(coreAgents, "current Kernel version: 0.30.0", "current Kernel version: 0.31.0", "Core AGENTS Kernel version");
coreAgents = replaceOnce(
  coreAgents,
  "Model Registry / Model Contract governance contract:\n\n```text",
  "Integration/Eventing public contract (same Worker, independent lifecycle):\n\n```text\napps/core/integration-eventing.openapi.yaml\ncurrent Integration/Eventing version: 0.1.0\n```\n\nModel Registry / Model Contract governance contract:\n\n```text",
  "Core AGENTS Eventing contract block",
);
coreAgents = coreAgents.replace(
  "Console Model publish/retire profiles may reference the existing Kernel Model Admin request/response schemas; they must not become a second hand-maintained Model Definition schema.",
  "Console Model publish/retire profiles reuse the Model Control Plane request/response schemas; they must not become a second hand-maintained Model Definition schema.",
);
await write("apps/core/AGENTS.md", coreAgents);

let coreReadme = await read("apps/core/README.md");
coreReadme = replaceOnce(coreReadme, "Core Kernel contract is **0.30.0**", "Core Kernel contract is **0.31.0**", "Core README Kernel version");
const modelControlHeading = "## Model Control Plane\n\nModel Registry validation/publication/retirement, immutable Model Contract governance and optional AI Model Proposal APIs are declared separately in `model-control-plane.openapi.yaml` **0.1.0**. Ordinary Runtime consumers do not need to pin this contract. Service automation keeps `models:manage`; Console model mutations add the Platform Admin human-actor/audit overlay.\n";
coreReadme = replaceOnce(
  coreReadme,
  modelControlHeading,
  `${modelControlHeading}\n## Integration / Eventing\n\nWebhook Endpoint / Event Subscription management, delivery diagnostics/test-send and signed reference-only outbound Webhook representation are declared in \`integration-eventing.openapi.yaml\` **0.1.0**. The routes still execute in the same Core Worker, but Runtime-only consumers do not need to pin Eventing.\n`,
  "Core README Eventing section",
);
await write("apps/core/README.md", coreReadme);

let architecture = await read("docs/architecture.md");
architecture = replaceOnce(architecture, "explicit product-facing Space / Grant / Creation Draft / Model Admin primitives\n  current Kernel contract: 0.30.0", "explicit product-facing Space / Grant / Runtime Discovery / Change History / Creation Draft primitives\n  current Kernel contract: 0.31.0", "architecture Kernel description/version");
architecture = replaceOnce(
  architecture,
  "Model Control Plane Contract\n  apps/core/model-control-plane.openapi.yaml",
  "Integration / Eventing Contract\n  apps/core/integration-eventing.openapi.yaml\n  Webhook Endpoint / Event Subscription / delivery + signed outbound Webhook representation\n  independent public companion contract: 0.1.0\n  executed by the same Core Worker; not part of the Kernel version/fingerprint\n\nModel Control Plane Contract\n  apps/core/model-control-plane.openapi.yaml",
  "architecture Eventing contract block",
);
architecture = replaceOnce(
  architecture,
  "The separate Model Control Plane prevents Model Registry governance and optional AI proposal syntax from being pinned by ordinary Runtime consumers. The separate Platform Admin contract prevents adding Console-only privileged APIs from forcing unrelated HomeMew/ALOHA business-contract pin changes. HomeMew handoff artifacts therefore continue to pin Identity/Core Kernel/Model Contract and do not automatically include the Platform Admin contract.",
  "The separate Model Control Plane prevents Model Registry governance and optional AI proposal syntax from being pinned by ordinary Runtime consumers. The independent Integration/Eventing contract does the same for Webhook/Eventing representation: Runtime-only consumers pin Identity/Core Kernel/Model semantics without Eventing, while consumers that use Eventing add its version. The separate Platform Admin contract prevents Console-only privileged APIs from forcing unrelated HomeMew/ALOHA business-contract pin changes. All three contract families may still execute through the same Core Worker without sharing a compatibility lifecycle.",
  "architecture contract-layer explanation",
);
await write("docs/architecture.md", architecture);

let contracts = await read("docs/contracts.md");
contracts = replaceOnce(contracts, "Core has four contract layers:", "Core has five contract layers:", "contracts layer count");
contracts = replaceOnce(
  contracts,
  "1. **Kernel Contract** — explicit application/runtime APIs such as Space, Membership, Data Grant, Runtime Discovery, Webhook Endpoint/Event Subscription, Registry-driven Creation Draft orchestration and governed Change History. The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.30.0` no longer owns Model Registry governance operations.\n2. **Model Control Plane Contract** — `apps/core/model-control-plane.openapi.yaml`, the independently versioned service-automation contract for Model Definition validation/publication/retirement, immutable Model Contract evidence and the optional AI-assisted proposal lifecycle. Its initial version is `0.1.0`; every operation remains service-principal-only with `models:manage`.\n3. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged Console companion profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Version `0.2.0` reuses Model Control Plane publish/retire wire schemas rather than treating Kernel as their owner.\n4. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.",
  "1. **Kernel Contract** — explicit application/runtime APIs such as Space, Membership, Data Grant, Runtime Discovery, Registry-driven Creation Draft orchestration and governed Change History. The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.31.0` owns neither Model Registry governance nor Eventing wire representation.\n2. **Integration / Eventing Contract** — `apps/core/integration-eventing.openapi.yaml`, the independently versioned public contract for Webhook Endpoint/Event Subscription management, delivery diagnostics/test-send and signed reference-only outbound Webhook representation. Its initial version is `0.1.0`; the same Core Worker still executes the routes.\n3. **Model Control Plane Contract** — `apps/core/model-control-plane.openapi.yaml`, the independently versioned service-automation contract for Model Definition validation/publication/retirement, immutable Model Contract evidence and the optional AI-assisted proposal lifecycle. Its initial version is `0.1.0`; every operation remains service-principal-only with `models:manage`.\n4. **Platform Admin Contract** — `apps/core/platform-admin.openapi.yaml`, a privileged Console companion profile for Application × Model Access, global read-only Space inspection, platform audit and human-attributed Console model mutations. Version `0.2.0` reuses Model Control Plane publish/retire wire schemas rather than treating Kernel as their owner.\n5. **Model Contract Revision** — immutable OpenAPI/JSON Schema snapshots generated from the published Model Registry plus registered Capability contract contributions.",
  "contracts five layers",
);
contracts = replaceOnce(contracts, "As of Core Kernel `0.30.0`", "As of Core Kernel `0.31.0`", "contracts current Kernel version");
contracts = replaceOnce(
  contracts,
  "Kernel `0.30.0` also removes `/model-admin/*` operations from Kernel ownership because those routes now belong to the separately versioned Model Control Plane `0.1.0` contract.",
  "Kernel `0.30.0` also removes `/model-admin/*` operations from Kernel ownership because those routes now belong to the separately versioned Model Control Plane `0.1.0` contract. Kernel `0.31.0` removes Webhook Endpoint/Event Subscription and delivery/test representation from Kernel ownership; Integration/Eventing `0.1.0` becomes their canonical public contract without moving runtime state, Queue delivery, authorization, revocation or signing out of the Core Worker.",
  "contracts 0.31 history",
);
contracts = replaceOnce(
  contracts,
  "Identity Application Contract: <pinned version>\nKernel Contract:               <pinned version>\nModel Contract evidence:       mct_<hash>",
  "Identity Application Contract: <pinned version>\nKernel Contract:               <pinned version>\nModel Contract evidence:       mct_<hash>\nIntegration/Eventing Contract: <pinned version; only when the consumer uses Eventing>",
  "contracts handoff tuple",
);
contracts = replaceOnce(
  contracts,
  "Identity Application Contract version\n+ Kernel Contract version\n+ Model Semantic Fingerprint",
  "Identity Application Contract version\n+ Kernel Contract version\n+ Model Semantic Fingerprint\n+ Integration/Eventing Contract version (for consumers such as HomeMew that use Eventing)",
  "contracts cross-environment tuple",
);
contracts = replaceOnce(
  contracts,
  "Core Platform Admin Contract:     0.1.0",
  "Core Platform Admin Contract:     0.2.0",
  "contracts Core Platform Admin version",
);
contracts = replaceOnce(
  contracts,
  "## Platform Admin control-plane contract",
  "## Integration / Eventing Contract\n\n`apps/core/integration-eventing.openapi.yaml` is the canonical public Eventing contract and starts at version `0.1.0`. It owns Webhook Endpoint/Event Subscription management, delivery diagnostics/test-send, the signed reference-only ordinary-record change payload, `endpoint.test`, required `X-LifeSpace-*` headers, HMAC-SHA256 signature representation and at-least-once delivery semantics.\n\nIt does **not** own ordinary-model Change production, model mutation semantics or a separate authorization model. The same Core Worker remains authoritative for Endpoint/Subscription state, Application × Model Access, Data Grants, subscriber Service Principal/application eligibility, Queue delivery and current revocation. Splitting the contract lifecycle therefore does not split the runtime or create another truth source.\n\nRuntime-only consumers omit this contract. Eventing consumers pin `Integration/Eventing 0.1.0` independently so future Eventing representation changes do not force unrelated Runtime consumers to repin Kernel, and vice versa.\n\n## Platform Admin control-plane contract",
  "contracts Eventing section",
);
contracts = contracts.replace(
  "- Both start at contract version `0.1.0`; the versions may advance independently later if the two services' admin syntax evolves at different rates.",
  "- Identity Platform Admin is `0.1.0`; Core Platform Admin is `0.2.0`. Their versions advance independently when each service's admin syntax changes.",
);
contracts = contracts.replace(
  "- Core's Console Model Admin paths intentionally refer to the existing Kernel Model Admin request/response schemas rather than authoring a second Model Definition contract. The Kernel remains authoritative for Model Definition/publication syntax; the Platform Admin contract adds the human-proof/audit profile.",
  "- Core's Console Model Admin paths reuse the Model Control Plane request/response schemas rather than authoring a second Model Definition contract. The Model Control Plane owns governance wire syntax; the Platform Admin contract adds the human-proof/audit profile.",
);
contracts = contracts.replaceAll("independently from `Kernel 0.30.0`", "independently from `Kernel 0.31.0`");
contracts = replaceOnce(
  contracts,
  "- Webhook Endpoint lifecycle, one-time signing-secret rotation, endpoint-level test/delivery diagnostics and attached Event Subscription filters;\n",
  "",
  "remove Eventing from Kernel contents",
);
contracts = replaceOnce(
  contracts,
  "Model Registry administration and immutable Model Contract governance are intentionally absent from Kernel 0.30.0 and live in the Model Control Plane contract instead.",
  "Model Registry administration and immutable Model Contract governance are intentionally absent from Kernel 0.31.0 and live in the Model Control Plane contract instead. Eventing representation is likewise absent from Kernel 0.31.0 and lives in Integration/Eventing 0.1.0.",
  "contracts Kernel ownership statement",
);
contracts = replaceOnce(
  contracts,
  "Kernel 0.15.0 models Eventing as two Kernel resources. A Webhook Endpoint owns the Space/subscriber binding, callback URL and signing secret. Event Subscriptions attach one published `modelKey` plus generic `record.created` / `record.updated` / `record.deleted` filters to that endpoint. The Webhook payload remains reference-only; consumers that need full record data must use the ordinary Model Contract route under their current service credential and Data Grant authority. Endpoint creation itself grants no model authority; subscription creation/enabling requires current managing model access and current subscriber Data Grant access.",
  "Kernel 0.15.0 historically introduced the current Eventing resource semantics. Kernel 0.31.0 removes their wire representation from the Kernel contract only; the same Core Worker, authorization and delivery semantics remain authoritative and are now described by Integration/Eventing 0.1.0.",
  "contracts Eventing history ownership",
);
await write("docs/contracts.md", contracts);

let baseline = JSON.parse(await read("docs/contract-stability-baseline.json"));
const coreEntry = baseline.contracts?.find((entry) => entry.id === "core-kernel");
if (!coreEntry) fail("contract stability baseline missing core-kernel");
coreEntry.operationSetSha256 = operationDigest(kernel);
coreEntry.groups = (coreEntry.groups ?? []).filter((group) => group.id !== "core-integration-eventing");
const eventingEntry = {
  id: "integration-eventing",
  source: "apps/core/integration-eventing.openapi.yaml",
  operationSetSha256: operationDigest(eventing),
  groups: [{
    id: "integration-eventing-public",
    maturity: "candidate",
    visibility: "public",
    operationPattern: "^(GET|POST) /api/v1/(event-subscriptions|webhook-endpoints)$|^(PATCH|DELETE) /api/v1/event-subscriptions/\\{subscriptionId\\}$|^(PATCH|DELETE) /api/v1/webhook-endpoints/\\{endpointId\\}$|^GET /api/v1/webhook-endpoints/\\{endpointId\\}/deliveries$|^POST /api/v1/webhook-endpoints/\\{endpointId\\}/test$",
  }],
};
baseline.contracts = (baseline.contracts ?? []).filter((entry) => entry.id !== "integration-eventing");
const coreIndex = baseline.contracts.findIndex((entry) => entry.id === "core-kernel");
baseline.contracts.splice(coreIndex + 1, 0, eventingEntry);
await write("docs/contract-stability-baseline.json", `${JSON.stringify(baseline, null, 2)}\n`);

let stability = await read("docs/contract-stability.md");
stability = stability.replaceAll("Core Kernel 0.30.0", "Core Kernel 0.31.0").replaceAll("Kernel 0.30.0", "Kernel 0.31.0");
await write("docs/contract-stability.md", stability);

console.log(JSON.stringify({
  ok: true,
  kernelVersion: kernel.info.version,
  kernelOperations: operations(kernel).length,
  kernelDigest: operationDigest(kernel),
  integrationEventingVersion: eventing.info.version,
  integrationEventingOperations: operations(eventing).length,
  integrationEventingDigest: operationDigest(eventing),
}, null, 2));

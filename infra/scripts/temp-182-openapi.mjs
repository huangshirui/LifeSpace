import fs from "node:fs";

const root = new URL("../../", import.meta.url);

function read(path) {
  return fs.readFileSync(new URL(path, root), "utf8");
}

function write(path, content) {
  fs.writeFileSync(new URL(path, root), content);
}

function replaceExact(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  return text.replace(before, after);
}

// 1. Strengthen the canonical Kernel OpenAPI mechanical gate for 0.27 + compact inventory.
{
  const path = "apps/core/scripts/check-openapi.mjs";
  let text = read(path);
  text = text.replaceAll('"0.26.0"', '"0.27.0"');
  text = replaceExact(
    text,
    '  "/api/v1/me/_discovery",\n  "/api/v1/spaces",',
    '  "/api/v1/me/_discovery",\n  "/api/v1/me/_discovery/inventory",\n  "/api/v1/spaces",',
    "check-openapi required inventory path",
  );
  text = replaceExact(
    text,
    'const discovery = document.paths?.["/api/v1/spaces/{spaceId}/_discovery"]?.get;\nconst aggregateDiscovery = document.paths?.["/api/v1/me/_discovery"]?.get;',
    'const discovery = document.paths?.["/api/v1/spaces/{spaceId}/_discovery"]?.get;\nconst aggregateDiscovery = document.paths?.["/api/v1/me/_discovery"]?.get;\nconst inventoryDiscovery = document.paths?.["/api/v1/me/_discovery/inventory"]?.get;',
    "check-openapi inventory route binding",
  );
  const anchor = 'if (schemas.RuntimeModelSemanticCapabilityBindings?.additionalProperties !== false\n    || !schemas.RuntimeModelSemanticCapabilityBindings?.properties?.calendar\n    || !schemas.RuntimeModelSemanticCapabilityBindings?.properties?.temporal) {\n  throw new Error("Single-model semantic detail must expose registered Calendar and Temporal semantic bindings");\n}\n';
  const inventoryChecks = `\nif (inventoryDiscovery?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RuntimeDiscoveryInventoryResponse"\n    || !inventoryDiscovery?.description?.includes("compact cross-Space")\n    || !inventoryDiscovery?.description?.includes("request-current capability preview")\n    || !inventoryDiscovery?.description?.includes("execution")) {\n  throw new Error("Compact current capability inventory must remain a request-current preview with execution-time rechecks");\n}\nconst inventoryAction = schemas.RuntimeDiscoveryInventoryAction;\nconst inventoryModel = schemas.RuntimeDiscoveryInventoryModel;\nconst inventoryEdge = schemas.RuntimeDiscoveryInventoryModelEdge;\nconst inventorySpace = schemas.RuntimeDiscoveryInventorySpace;\nconst inventoryData = schemas.RuntimeDiscoveryInventoryResponse?.properties?.data;\nconst exactProperties = (schema, expected) => schema?.additionalProperties === false\n  && JSON.stringify(Object.keys(schema?.properties ?? {}).sort()) === JSON.stringify([...expected].sort());\nif (!exactProperties(inventoryAction, ["key", "access", "kind"])\n    || inventoryAction?.properties?.input\n    || inventoryAction?.properties?.concurrency) {\n  throw new Error("Compact capability inventory actions must expose only coarse key/access/kind facts");\n}\nif (!exactProperties(inventoryModel, ["key", "route", "version", "schemaHash", "display", "capabilities", "actions"])\n    || inventoryModel?.properties?.fields\n    || inventoryModel?.properties?.defaults\n    || inventoryModel?.properties?.query\n    || inventoryModel?.properties?.capabilityBindings\n    || inventoryModel?.properties?.access) {\n  throw new Error("Compact capability inventory models must de-duplicate only coarse static model facts");\n}\nif (!exactProperties(inventoryEdge, ["modelKey", "access"])\n    || !exactProperties(inventorySpace, ["spaceId", "spaceName", "models"])) {\n  throw new Error("Compact capability inventory Space entries must remain minimal dynamic visibility edges");\n}\nif (inventoryData?.additionalProperties !== false\n    || JSON.stringify(inventoryData?.required) !== JSON.stringify(["semanticDetailPathTemplate", "models", "spaces"])\n    || inventoryData?.properties?.semanticDetailPathTemplate?.const !== "/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"\n    || inventoryData?.properties?.models?.items?.$ref !== "#/components/schemas/RuntimeDiscoveryInventoryModel"\n    || inventoryData?.properties?.spaces?.items?.$ref !== "#/components/schemas/RuntimeDiscoveryInventorySpace") {\n  throw new Error("Compact capability inventory must point deterministically to progressive single-model semantic detail");\n}\n`;
  text = replaceExact(text, anchor, `${anchor}${inventoryChecks}`, "check-openapi inventory invariants");
  write(path, text);
}

// 2. Classify the additive 0.27 route as Candidate/Public and refresh only the complete Core operation-set fingerprint.
{
  const path = "docs/contract-stability-baseline.json";
  const baseline = JSON.parse(read(path));
  const core = baseline.contractSources.find((source) => source.id === "core-kernel");
  if (!core) throw new Error("contract baseline: core-kernel source missing");
  if (core.operationSetSha256 !== "sha256:5d09bb29685e269da92e8cee70b9f79b3fabed70c187f4abedfe0f5d6f89d2ec") {
    throw new Error(`contract baseline: unexpected previous Core operation fingerprint ${core.operationSetSha256}`);
  }
  core.operationSetSha256 = "sha256:ad36574efe47dcd7b251dc2d6b2e1919c38a4261a873a2668275e76b875a1b55";
  const discovery = core.groups.find((group) => group.id === "core-runtime-discovery");
  if (!discovery || discovery.maturity !== "candidate" || discovery.visibility !== "public") {
    throw new Error("contract baseline: Runtime Discovery Candidate/Public classification missing");
  }
  const expectedOld = "^GET /api/v1/(me|spaces/\\\\{spaceId\\\\})/_discovery$|^GET /api/v1/spaces/\\\\{spaceId\\\\}/_discovery/models/\\\\{modelKey\\\\}$";
  if (discovery.operationPattern !== expectedOld) {
    throw new Error(`contract baseline: unexpected Runtime Discovery pattern ${discovery.operationPattern}`);
  }
  discovery.operationPattern = "^GET /api/v1/me/_discovery(?:/inventory)?$|^GET /api/v1/spaces/\\\\{spaceId\\\\}/_discovery$|^GET /api/v1/spaces/\\\\{spaceId\\\\}/_discovery/models/\\\\{modelKey\\\\}$";
  write(path, `${JSON.stringify(baseline, null, 2)}\n`);
}

// 3. Reconcile architecture current-state docs while preserving historical 0.23-0.25 statements.
{
  const path = "docs/architecture.md";
  let text = read(path);
  const oldParagraph = "Relation structure and relation instances deliberately live at different layers. Model Definition / generated JSON Schema owns stable relation target/cardinality semantics; Runtime Context Projection resolves current relation targets under live authority. Kernel `0.23.0` provides source-field-aware Person target lookup as minimal `{id,label}` references for generated clients without exposing Space membership-management data. This lookup is not a UI widget contract and is not mutation authority; adapters decide presentation, while create/update Policy and relation integrity are rechecked at execution. Record-relation lookup remains explicitly unavailable until LifeSpace has canonical record reference-label semantics instead of adapter heuristics such as guessing `name`, `title` or `summary`. Kernel `0.24.0` also projects a minimal current human-readable Space label alongside an already-authorized Runtime Discovery Space reference, so n8n, MCP, Agents and generated UI can present the same Space without acquiring Space membership-management metadata or authority. Kernel `0.25.0` adds bounded standard Capability field-role bindings to the same projection, beginning with Calendar timed/all-day field roles; these bindings expose reusable semantics without promoting adapter UI layout into platform truth.";
  const newParagraph = `${oldParagraph} Kernel \`0.26.0\` separates the Static Semantic Plane from dynamic visibility by adding \`GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}\`: Space is only a current visibility gate, while a successful semantic body is authority-independent and cacheable by \`(key, version, schemaHash)\`; missing and currently invisible models share an opaque 404, and execution still rechecks current authority. Kernel \`0.27.0\` adds \`GET /api/v1/me/_discovery/inventory\` as the compact Dynamic Visibility Plane: coarse static Model/Action/Capability facts are de-duplicated once, each reachable Space carries only minimal \`modelKey + effective access\` edges, and heavyweight field/default/query/action-input/Capability-binding semantics are loaded progressively through the 0.26 detail route. The older full Discovery surfaces remain available for compatibility and are never authorization proof.`;
  text = replaceExact(text, oldParagraph, newParagraph, "architecture Runtime Discovery history");
  text = replaceExact(text, "  current Kernel contract: 0.25.0", "  current Kernel contract: 0.27.0", "architecture current Kernel version");
  write(path, text);
}

// 4. Reconcile contract strategy for 0.26 static detail + 0.27 compact inventory.
{
  const path = "docs/contracts.md";
  let text = read(path);
  text = replaceExact(text, "As of Core Kernel `0.25.0`, ordinary model paths/schemas remain deliberately absent", "As of Core Kernel `0.27.0`, ordinary model paths/schemas remain deliberately absent", "contracts current Kernel version");
  const historyTail = "Kernel `0.25.0` adds bounded `capabilityBindings` for standard Capability field roles, beginning with Calendar, while preserving the existing `capabilities` inventory; the bindings are semantic Context Projection, not UI layout or mutation authority.";
  text = replaceExact(text, historyTail, `${historyTail} Kernel \`0.26.0\` adds progressive single-model static semantic detail behind a current Space visibility gate, with an authority-independent successful body identified by \`(key, version, schemaHash)\` and opaque missing/invisible 404 semantics. Kernel \`0.27.0\` adds a compact current-principal capability inventory that de-duplicates coarse static model facts from per-Space visibility/access edges and links deterministically to the 0.26 detail surface; full Discovery remains compatible and optional.`, "contracts top version history");
  const discoveryBlock = "GET /api/v1/me/_discovery\n  -> across all currently reachable source Spaces, return only Spaces with at least one effective model capability";
  text = replaceExact(text, discoveryBlock, `${discoveryBlock}\n\nGET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}\n  -> use the Space only as a current visibility gate, then return static semantics for one visible model identity\n\nGET /api/v1/me/_discovery/inventory\n  -> return compact request-current Space/model visibility edges plus de-duplicated coarse model facts`, "contracts Runtime Discovery route inventory");
  const capParagraph = "Kernel `0.25.0` also exposes a bounded `capabilityBindings` object on each discovered model. `capabilities` remains the backwards-compatible inventory of enabled standard Capability names. `capabilityBindings.calendar` carries only the canonical model-field roles already declared by the published Calendar Capability mapping (all-day marker, timed start/end, timezone fields, all-day date range and optional attendee field). Generic clients may use those roles to understand mutually exclusive timed/all-day shapes without guessing Event field names. Core execution remains authoritative for Calendar validation, and the projection deliberately contains no renderer/widget/layout instructions.";
  const progressiveParagraphs = `${capParagraph}\n\nKernel \`0.26.0\` adds the progressive **Static Semantic Plane** at \`GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}\`. The Space participates only in the request-current visibility check. On success the body contains static model semantics—not Membership, Grant, Delegation or effective-access state—and is stable for the returned \`(key, version, schemaHash)\`. Missing and currently non-discoverable models intentionally use the same opaque 404 so semantic-detail lookup does not become a model-existence side channel. Every actual CRUD/query/Action still rechecks current authority.\n\nKernel \`0.27.0\` adds the compact **Dynamic Visibility Plane** at \`GET /api/v1/me/_discovery/inventory\`. It uses the same live authority intersection as aggregate Discovery, but materializes coarse static model identity/display/Capability/Action facts only once and represents each reachable Space as minimal \`modelKey + effective access\` edges. Heavy fields/defaults/query/action-input/Capability-binding semantics are deliberately omitted and loaded only when needed through the deterministic 0.26 semantic-detail path template. This prevents \`S × M\` duplication from becoming the default Agent/LLM context while preserving the existing full Discovery surfaces for compatible consumers. Cached positive inventory is never execution authority.`;
  text = replaceExact(text, capParagraph, progressiveParagraphs, "contracts progressive projection paragraphs");
  const oldChain = "A Kernel behavior change is versioned independently from model publication. The Phase-3 contract split moved Core from the Phase-2 `0.11.0` combined-domain contract to Kernel `0.12.0`; Kernel `0.13.0` added backwards-compatible model-collection Data Grant targeting for external integrations; Kernel `0.14.0` introduced generic Eventing; Kernel `0.15.0` separates shared Webhook Endpoint transport/signing from model/event subscription filters; Kernel `0.16.0` adds owner-only logical Space close; Kernel `0.17.0` adds Agent Delegation/governed Change; Kernel `0.18.0` adds cross-Space current-principal Runtime Discovery; Kernel `0.19.0` exposes authoritative Model server defaults through Runtime Discovery while keeping default application in Generic Runtime semantics; Kernel `0.20.0` separates Action semantic input from optimistic-concurrency metadata without changing the current body-based concurrency transport; Kernel `0.21.0` moves Space invitation bearer tokens from URL paths to JSON request bodies as a Candidate/Public security migration without changing invitation lifecycle semantics; Kernel `0.22.0` adds ordered multi-field Generic Query sorting and Agent-readable canonical field titles across Runtime Discovery and generated model contracts.";
  const newChain = `${oldChain.slice(0, -1)}; Kernel \`0.23.0\` adds source-field-aware Person Relation Target Lookup; Kernel \`0.24.0\` adds minimal current \`spaceName\` Context Projection; Kernel \`0.25.0\` adds bounded standard Capability field-role bindings; Kernel \`0.26.0\` adds progressive single-model static semantic detail; Kernel \`0.27.0\` adds the compact current capability inventory.`;
  text = replaceExact(text, oldChain, newChain, "contracts Kernel history chain");
  text = replaceExact(
    text,
    "- Runtime Discovery checks preserve current authority intersection, preview-only semantics, Agent Delegation narrowing, authoritative Model defaults, Action semantic-input/concurrency separation and the cross-Space no-detail-leak boundary;",
    "- Runtime Discovery checks preserve current authority intersection, preview-only semantics, Agent Delegation narrowing, authoritative Model defaults, Action semantic-input/concurrency separation, progressive static-detail opacity, compact inventory de-duplication/boundedness and the cross-Space no-detail-leak boundary;",
    "contracts required Runtime Discovery checks",
  );
  write(path, text);
}

// 5. Add a concise current-Kernel pointer without rewriting historical Phase-2 evidence.
{
  const path = "apps/core/README.md";
  let text = read(path);
  const anchor = "- Health/status diagnostics and standard success/error envelopes.\n\n## Phase 2 native HomeMew capability replacement";
  const section = `- Health/status diagnostics and standard success/error envelopes.\n\n## Current Kernel Runtime Discovery\n\nThe current business-facing Core Kernel contract is **0.27.0**. Generic consumers may choose the projection size appropriate to the task:\n\n- \`GET /api/v1/spaces/{spaceId}/_discovery\` — full current capability metadata for one known Space;\n- \`GET /api/v1/me/_discovery\` — full aggregate current capability metadata across reachable Spaces;\n- \`GET /api/v1/me/_discovery/inventory\` — compact current capability inventory with de-duplicated coarse model facts and minimal per-Space visibility/access edges;\n- \`GET /api/v1/spaces/{spaceId}/_discovery/models/{modelKey}\` — progressive static semantic detail for one currently visible model.\n\nThe progressive Runtime Discovery representations are Candidate/Public Context Projections. They reflect current visibility when requested but never authorize execution; every CRUD/query/Action rechecks current authority and model/Capability rules.\n\n## Phase 2 native HomeMew capability replacement`;
  text = replaceExact(text, anchor, section, "Core README current Kernel section");
  write(path, text);
}

// 6. Remove the one-time materializer/finalizer from the feature branch itself.
fs.unlinkSync(new URL("infra/scripts/temp-182-openapi.mjs", root));
fs.unlinkSync(new URL(".github/workflows/temp-182-openapi.yml", root));

console.log("#182 one-time finalization complete");

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const file = (relative) => path.join(root, relative);
const read = (relative) => fs.readFileSync(file(relative), "utf8");
const write = (relative, content) => fs.writeFileSync(file(relative), content, "utf8");
const remove = (relative) => {
  if (!fs.existsSync(file(relative))) throw new Error(`Expected file to remove: ${relative}`);
  fs.rmSync(file(relative));
};
const replaceRequired = (relative, before, after) => {
  const current = read(relative);
  if (!current.includes(before)) throw new Error(`Expected text missing in ${relative}: ${before.slice(0, 120)}`);
  write(relative, current.replace(before, after));
};
const removeLinesContaining = (relative, needles) => {
  const current = read(relative);
  const next = current.split("\n").filter((line) => !needles.some((needle) => line.includes(needle))).join("\n");
  if (next === current) throw new Error(`No requested lines removed from ${relative}`);
  write(relative, next);
};
const removeTestBlock = (source, title) => {
  const marker = `test("${title}", () => {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Test block not found: ${title}`);
  const end = source.indexOf("\n});", start);
  if (end < 0) throw new Error(`Test block terminator not found: ${title}`);
  return `${source.slice(0, start)}${source.slice(end + 5)}`;
};
const parseJson = (relative) => JSON.parse(read(relative));
const writeJson = (relative, value) => write(relative, `${JSON.stringify(value, null, 2)}\n`);

for (const relative of [
  "apps/core/src/creation-draft-cleanup.ts",
  "apps/core/src/registry-creation-draft.ts",
  "apps/core/src/registry-creation-draft-jobs.ts",
  "apps/core/test/creation-draft-model-semantics.test.ts",
  "apps/core/test/registry-openai-provider.test.ts",
  "infra/scripts/verify-staging-creation-draft.mjs",
]) remove(relative);

replaceRequired("apps/core/src/app.ts", 'import { registerRegistryCreationDraftRoutes } from "./registry-creation-draft-jobs";\n', "");
replaceRequired("apps/core/src/app.ts", "  registerRegistryCreationDraftRoutes(app);\n", "");
replaceRequired("apps/core/src/env.ts", "  CREATION_DRAFT_QUEUE: Queue;\n", "");
removeLinesContaining("apps/core/src/worker-configuration.d.ts", ["CREATION_DRAFT_QUEUE"]);

write("apps/core/src/index.ts", `import { createApp } from "./app";
import { dispatchPendingDomainEvents, processWebhookDeliveryQueue, type WebhookDeliveryQueueMessage } from "./eventing";
import type { Bindings } from "./env";

const app = createApp();

export default {
  fetch: app.fetch.bind(app),
  async queue(batch: MessageBatch<WebhookDeliveryQueueMessage>, env: Bindings): Promise<void> {
    await processWebhookDeliveryQueue(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Bindings): Promise<void> {
    const dispatched = await dispatchPendingDomainEvents(env);
    if (dispatched > 0) console.log("Domain events dispatched", { dispatched });
  },
};
`);

write("apps/core/src/registry-openai-provider.ts", `export type ProviderErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_REQUEST_REJECTED"
  | "AI_AUTHENTICATION_FAILED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_ACCESS_DENIED"
  | "AI_MODEL_NOT_FOUND"
  | "AI_UPSTREAM_UNAVAILABLE"
  | "AI_INVALID_RESPONSE";

export class OpenAICompatibleProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
  }
}

export type AiProviderResult = {
  output: unknown;
  metadata: {
    providerStatus: number;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  };
};

export type OpenAICompatibleProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptAppendix?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  appTitle?: string;
  appReferer?: string;
  requireParameters?: boolean;
};
`);
for (const relative of ["apps/core/src/model-admin-ai-provider.ts", "apps/core/src/model-admin-ai.ts"]) {
  write(relative, read(relative).replaceAll("CreationProviderResult", "AiProviderResult"));
}

{
  const relative = "apps/core/test/temporal-range-storage.test.ts";
  let current = read(relative).replace('import { normalizeRegistryCreationDraft } from "../src/registry-creation-draft";\n', "");
  const start = current.indexOf('  it("normalizes Creation Draft ranges and discards invalid inferred values", () => {');
  const end = current.indexOf('  it("publishes the direct TemporalRange filter surface",', start);
  if (start < 0 || end < 0) throw new Error("Creation Draft TemporalRange test block not found");
  current = `${current.slice(0, start)}${current.slice(end)}`;
  write(relative, current);
}

{
  const wrangler = parseJson("apps/core/wrangler.jsonc");
  const cleanQueues = (config) => {
    if (!config?.queues) return;
    config.queues.producers = (config.queues.producers ?? []).filter((item) => item.binding !== "CREATION_DRAFT_QUEUE");
    config.queues.consumers = (config.queues.consumers ?? []).filter((item) => !String(item.queue ?? "").includes("creation-drafts"));
  };
  cleanQueues(wrangler);
  for (const env of Object.values(wrangler.env ?? {})) cleanQueues(env);
  writeJson("apps/core/wrangler.jsonc", wrangler);
}

{
  const pkg = parseJson("apps/core/package.json");
  if (pkg.version !== "0.47.0") throw new Error(`Unexpected Core package version ${pkg.version}`);
  pkg.version = "0.48.0";
  writeJson("apps/core/package.json", pkg);
}
replaceRequired("apps/core/src/kernel-contract.ts", 'CORE_KERNEL_CONTRACT_VERSION = "0.47.0"', 'CORE_KERNEL_CONTRACT_VERSION = "0.48.0"');

{
  const relative = "apps/core/openapi.yaml";
  const document = JSON.parse(read(relative));
  if (document.info?.version !== "0.47.0") throw new Error(`Unexpected Kernel OpenAPI version ${document.info?.version}`);
  document.info.version = "0.48.0";
  document.info.description = String(document.info.description ?? "")
    .replace(", assets and Registry-driven Creation Draft orchestration.", " and assets.")
    .replace(", assets, and Registry-driven Creation Draft orchestration.", ", and assets.")
    .replaceAll("Creation Draft", "natural-language creation");
  document.info.description += " Kernel 0.48.0 removes the experimental natural-language creation orchestration surface from Core; interpretation and product conversation orchestration belong to replaceable adapters or product agents rather than the Kernel.";
  document.tags = (document.tags ?? []).filter((tag) => tag?.name !== "Creation Drafts");
  for (const key of Object.keys(document.paths ?? {})) {
    if (key.includes("/creation-drafts")) delete document.paths[key];
  }
  if (document.components?.parameters) delete document.components.parameters.DraftId;
  for (const key of Object.keys(document.components?.schemas ?? {})) {
    if (key.includes("CreationDraft") || key === "DraftWarning") delete document.components.schemas[key];
  }
  const contractVersion = document.components?.schemas?.StatusResponse?.properties?.data?.properties?.contractVersion;
  if (!contractVersion || contractVersion.const !== "0.47.0") throw new Error("StatusResponse Core contract version is not 0.47.0");
  contractVersion.const = "0.48.0";
  write(relative, JSON.stringify(document));
}

{
  const relative = "apps/core/scripts/check-openapi.mjs";
  let current = read(relative).replaceAll('document.info?.version !== "0.47.0"', 'document.info?.version !== "0.48.0"');
  current = current.replace(/\nif \(document\.paths\?\.\["\/api\/v1\/spaces\/\{spaceId\}\/creation-drafts\/\{draftId\}\/choose-kind"\]\) \{\n  throw new Error\("Hard-coded Creation Draft choose-kind route must not remain"\);\n\}\n/u, "\n");
  current = current.split("\n").filter((line) => !line.includes('"/api/v1/spaces/{spaceId}/creation-drafts')).join("\n");
  current = current.replace('/^(Event|Task|DayRecord|Wish|CreationDraftEvent|CreationDraftTask|CreationDraftDayRecord|CreationDraftWish)/', '/^(Event|Task|DayRecord|Wish)/');
  write(relative, current);
}

{
  const baseline = parseJson("docs/contract-stability-baseline.json");
  for (const source of baseline.contractSources ?? []) {
    if (Array.isArray(source.groups)) source.groups = source.groups.filter((group) => group.id !== "core-creation-drafts");
  }
  writeJson("docs/contract-stability-baseline.json", baseline);
}

write("apps/core/migrations/0053_remove_creation_draft_jobs.sql", `-- Retire the experimental natural-language creation orchestration persistence surface.
-- Historical migrations remain immutable; current schema no longer carries its job table.

DROP TABLE IF EXISTS creation_draft_jobs;

UPDATE schema_metadata SET value='53' WHERE key='schema_version';
`);

for (const relative of ["infra/staging/resources.json", "infra/production/resources.json"]) {
  const resources = parseJson(relative);
  resources.queues = (resources.queues ?? []).filter((item) => !String(item.name ?? "").includes("creation-drafts"));
  writeJson(relative, resources);
}
removeLinesContaining("infra/scripts/prepare-staging-smoke.mjs", ["creation-drafts:read", "creation-drafts:write"]);

{
  const relative = "infra/scripts/check-production-infra.mjs";
  let current = read(relative);
  current = current.replace('    "lifespace-creation-drafts",\n', "");
  current = current.replace('    "\\\"queue\\\": \\\"lifespace-creation-drafts\\\"",\n', "");
  write(relative, current);
}

{
  const relative = "infra/scripts/verify-production-cloudflare.mjs";
  let current = read(relative);
  const start = current.indexOf('const productionQueue = queueByName.get("lifespace-creation-drafts");');
  const end = current.indexOf('for (const [productionName, stagingName] of [', start);
  if (start < 0 || end < 0) throw new Error("Production Creation Draft queue isolation block not found");
  current = `${current.slice(0, start)}${current.slice(end)}`;
  current = current.replace('requireBinding(coreBindings, { name: "CREATION_DRAFT_QUEUE", type: "queue", fields: { queue_name: "lifespace-creation-drafts" } }, "lifespace-core");\n', "");
  current = current.replace('["DB", "ASSETS", "IDENTITY", "CREATION_DRAFT_QUEUE", "EVENT_DELIVERY_QUEUE"]', '["DB", "ASSETS", "IDENTITY", "EVENT_DELIVERY_QUEUE"]');
  write(relative, current);
}

for (const relative of ["infra/staging/README.md", "infra/production/README.md", "infra/README.md"]) {
  const current = read(relative);
  write(relative, current.split("\n").filter((line) => {
    const lower = line.toLowerCase();
    return !lower.includes("creation draft") && !lower.includes("creation-draft") && !lower.includes("creation_draft");
  }).join("\n"));
}

{
  const relative = ".github/workflows/staging-deploy.yml";
  let current = read(relative);
  current = current.replace('          node --check infra/scripts/verify-staging-creation-draft.mjs\n', "");
  current = current.replace('\n      - name: Verify Registry-driven Creation Draft Queue\n        run: node infra/scripts/verify-staging-creation-draft.mjs\n', "\n");
  current = current.replace('      - name: Publish or verify baseline model semantics for Creation Draft classification\n', '      - name: Publish or verify baseline model semantics\n');
  current = current.split("\n").filter((line) => !line.includes("Registry-driven Creation Draft Queue:")).join("\n");
  write(relative, current);
}

removeLinesContaining("apps/core/scripts/staging-verifiers.test.mjs", ["verify-staging-creation-draft.mjs"]);
{
  const relative = "apps/core/scripts/staging-smoke.test.mjs";
  let current = read(relative);
  current = current.replace('const creationDraftSmoke = new URL("../../../infra/scripts/verify-staging-creation-draft.mjs", import.meta.url);\n', "");
  current = current.replace(', creationDraftSmoke,', ',');
  const mixedStart = current.indexOf('  const creationSource = readFileSync(fileURLToPath(creationDraftSmoke), "utf8");');
  const mixedEnd = current.indexOf("\n});", mixedStart);
  if (mixedStart < 0 || mixedEnd < 0) throw new Error("Embedded Creation Draft semantic assertions not found");
  current = `${current.slice(0, mixedStart)}${current.slice(mixedEnd)}`;
  current = removeTestBlock(current, "staging Creation Draft verifier tolerates only bounded transient Model Admin authentication failures");
  current = removeTestBlock(current, "staging Creation Draft verifier runs before long-lived Eventing and performance diagnostics");
  write(relative, current);
}

replaceRequired("docs/architecture.md", "- Registry-driven Creation Draft orchestration;\n", "");
replaceRequired("docs/contracts.md", ", Registry-driven Creation Draft orchestration", "");
for (const relative of [
  "docs/model-definition-spec.md",
  "docs/canonical-query.md",
  "docs/time-space-semantics.md",
  "docs/contract-stability.md",
  "docs/lifespace-console-configuration-center.md",
  "README.md",
]) {
  if (!fs.existsSync(file(relative))) continue;
  let current = read(relative);
  current = current.replaceAll("Generated Model Contracts and Creation Draft schemas", "Generated Model Contracts");
  current = current.replaceAll("Creation Draft schemas and generated Model Contracts", "Generated Model Contracts");
  current = current.replaceAll("Creation Draft", "product-side creation interpretation");
  current = current.replaceAll("creation-draft", "product-side-creation");
  current = current.replaceAll("creation draft", "product-side creation interpretation");
  write(relative, current);
}

const allowedResidualFiles = new Set([
  "apps/core/migrations/0009_creation_draft_jobs.sql",
  "apps/core/migrations/0015_registry_creation_drafts.sql",
  "apps/core/migrations/0053_remove_creation_draft_jobs.sql",
  "tools/remove-creation-draft.mjs",
  ".github/workflows/zz-remove-creation-draft.yml",
]);
const residualPattern = /creation[ _-]?draft|creation-drafts|CREATION_DRAFT/iu;
const ignoredDirs = new Set([".git", "node_modules", "dist", ".wrangler"]);
const residuals = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
    if (entry.isDirectory()) { walk(absolute); continue; }
    if (allowedResidualFiles.has(relative)) continue;
    if (residualPattern.test(relative)) residuals.push(`${relative}: filename`);
    let content;
    try { content = fs.readFileSync(absolute, "utf8"); } catch { continue; }
    content.split("\n").forEach((line, index) => {
      if (residualPattern.test(line)) residuals.push(`${relative}:${index + 1}: ${line.trim().slice(0, 180)}`);
    });
  }
}
walk(root);
if (residuals.length) {
  console.error("Residual Creation Draft references remain:\n" + residuals.join("\n"));
  process.exit(2);
}
console.log("Creation Draft current capability/infrastructure cleanup prepared; immutable migration history intentionally retained.");

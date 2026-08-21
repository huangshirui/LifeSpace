import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const coreBaseUrl = (process.env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
const bearer = process.env.LIFESPACE_STAGING_USER_BEARER ?? "";
const spaceId = process.env.LIFESPACE_STAGING_SPACE_ID ?? "";
const viewingTimezone = process.env.LIFESPACE_STAGING_VIEWING_TIMEZONE ?? "UTC";
const text = process.env.LIFESPACE_STAGING_CREATION_TEXT ?? "明天记得交电费";
const expectedModel = process.env.LIFESPACE_STAGING_CREATION_EXPECT_MODEL ?? "task";
const expectedContract = process.env.LIFESPACE_STAGING_CREATION_EXPECT_CONTRACT ?? "mct_37f64546f9ebaf9697ee34b6b692ba3b96976a015b7ab5e5b243018fd3cfb41b";
const allowAiUnconfigured = process.env.ALLOW_AI_UNCONFIGURED === "1";
const timeoutMs = Number(process.env.LIFESPACE_STAGING_CREATION_TIMEOUT_MS ?? 75_000);

for (const [name, value] of Object.entries({
  LIFESPACE_CORE_STAGING_URL: coreBaseUrl,
  LIFESPACE_STAGING_USER_BEARER: bearer,
  LIFESPACE_STAGING_SPACE_ID: spaceId,
})) {
  if (!value) throw new Error(`${name} is required`);
}

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${coreBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { throw new Error(`${method} ${path} returned non-JSON ${response.status}: ${raw.slice(0, 500)}`); }
  }
  return { status: response.status, payload };
}

function data(result, expectedStatus, label) {
  if (result.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${result.status}: ${JSON.stringify(result.payload)}`);
  }
  return result.payload?.data;
}

function validContract(value) {
  return typeof value === "string" && /^mct_[a-f0-9]{64}$/u.test(value);
}

const created = data(await request(`/api/v1/spaces/${spaceId}/creation-drafts`, {
  method: "POST", body: { text, viewingTimezone },
}), 202, "Creation Draft enqueue");
if (!created?.draftId || created.status !== "processing") throw new Error(`Creation Draft enqueue shape mismatch: ${JSON.stringify(created)}`);
if (!validContract(created.modelContractRevision)) throw new Error(`Creation Draft did not pin a valid Model Contract Revision: ${JSON.stringify(created)}`);
if (expectedContract && created.modelContractRevision !== expectedContract) {
  throw new Error(`Creation Draft contract mismatch: expected ${expectedContract}, got ${created.modelContractRevision}`);
}

const draftId = created.draftId;
const pinnedContract = created.modelContractRevision;
const started = Date.now();
let chosen = false;
let terminal = null;

while (Date.now() - started < timeoutMs) {
  await delay(1_500);
  const current = data(await request(`/api/v1/spaces/${spaceId}/creation-drafts/${draftId}`), 200, "Creation Draft poll");
  if (!current) throw new Error("Creation Draft poll returned no data");
  if (current.modelContractRevision !== pinnedContract) throw new Error(`Creation Draft Model Contract pin changed: ${JSON.stringify(current)}`);
  if (current.status === "processing") continue;
  if (current.status === "choose_model") {
    if (expectedModel) {
      throw new Error(`Creation Draft expected direct ${expectedModel} classification, got choose_model: ${JSON.stringify(current)}`);
    }
    if (chosen) throw new Error("Creation Draft returned choose_model twice after explicit model choice");
    if (!Array.isArray(current.candidateModels) || current.candidateModels.length < 2) throw new Error(`choose_model candidates are invalid: ${JSON.stringify(current)}`);
    const target = current.candidateModels[0];
    const choose = data(await request(`/api/v1/spaces/${spaceId}/creation-drafts/${draftId}/choose-model`, {
      method: "POST", body: { targetModelKey: target },
    }), 202, "Creation Draft choose-model");
    if (choose?.modelContractRevision !== pinnedContract) throw new Error(`choose-model changed the pinned contract: ${JSON.stringify(choose)}`);
    chosen = true;
    continue;
  }
  terminal = current;
  break;
}

if (!terminal) throw new Error(`Creation Draft did not reach a terminal state within ${timeoutMs}ms`);
if (terminal.status === "failed") {
  const code = terminal.error?.code;
  const configurationErrors = new Set(["AI_NOT_CONFIGURED", "AI_AUTHENTICATION_FAILED", "AI_MODEL_NOT_FOUND", "AI_ACCESS_DENIED", "AI_QUOTA_EXCEEDED"]);
  if (!allowAiUnconfigured || !configurationErrors.has(code)) throw new Error(`Creation Draft failed unexpectedly: ${JSON.stringify(terminal)}`);
  console.log(JSON.stringify({ ok: true, mode: "ai-unconfigured", draftId, modelContractRevision: pinnedContract, terminalError: code, queueAndWorkerReachedTerminalState: true }, null, 2));
  process.exit(0);
}

if (terminal.status !== "ready") throw new Error(`Unexpected Creation Draft terminal state: ${JSON.stringify(terminal)}`);
if (!terminal.modelKey || !terminal.draft || !Array.isArray(terminal.missingFields) || !Array.isArray(terminal.warnings)) {
  throw new Error(`Ready Creation Draft shape mismatch: ${JSON.stringify(terminal)}`);
}
if (expectedModel && terminal.modelKey !== expectedModel) throw new Error(`Creation Draft model mismatch: expected ${expectedModel}, got ${terminal.modelKey}`);

console.log(JSON.stringify({
  ok: true,
  mode: "ai-ready",
  draftId,
  modelContractRevision: pinnedContract,
  modelKey: terminal.modelKey,
  modelVersion: terminal.modelVersion,
  directClassification: !chosen,
  missingFields: terminal.missingFields,
  warningCount: terminal.warnings.length,
}, null, 2));

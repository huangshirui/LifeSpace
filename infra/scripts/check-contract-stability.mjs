import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../..");
const baselinePath = resolve(root, "docs/contract-stability-baseline.json");
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

function fail(message) {
  throw new Error(`[contract-stability] ${message}`);
}

function parseJsonOperations(text, source) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    fail(`${source} looks like JSON but cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const operations = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const method of Object.keys(item)) {
      if (httpMethods.has(method.toLowerCase())) operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return operations;
}

function parseYamlOperations(text, source) {
  const lines = text.split(/\r?\n/);
  const pathsIndex = lines.findIndex((line) => line === "paths:");
  if (pathsIndex < 0) fail(`${source} has no top-level paths section`);

  const operations = [];
  let currentPath = null;
  for (let index = pathsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) break;

    const pathMatch = line.match(/^  (\/.*):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }

    const methodMatch = line.match(/^    (get|post|put|patch|delete|options|head|trace):\s*$/i);
    if (methodMatch && currentPath) operations.push(`${methodMatch[1].toUpperCase()} ${currentPath}`);
  }
  return operations;
}

function parseOperations(text, source) {
  const trimmed = text.trimStart();
  const operations = trimmed.startsWith("{")
    ? parseJsonOperations(text, source)
    : parseYamlOperations(text, source);
  const unique = [...new Set(operations)].sort();
  if (unique.length === 0) fail(`${source} produced an empty operation set`);
  return unique;
}

function operationDigest(operations) {
  return `sha256:${createHash("sha256").update(operations.join("\n")).digest("hex")}`;
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join(", ")}; received ${JSON.stringify(value)}`);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
if (baseline.schemaVersion !== 1) fail(`unsupported schemaVersion ${JSON.stringify(baseline.schemaVersion)}`);
if (!Array.isArray(baseline.maturityValues) || baseline.maturityValues.join(",") !== "stable,candidate,experimental") {
  fail("maturityValues must be exactly stable,candidate,experimental");
}
if (!Array.isArray(baseline.visibilityValues) || baseline.visibilityValues.join(",") !== "public,internal") {
  fail("visibilityValues must be exactly public,internal");
}

const semanticIds = new Set();
for (const invariant of baseline.semanticInvariants ?? []) {
  if (!invariant?.id || semanticIds.has(invariant.id)) fail(`semantic invariant id is missing or duplicated: ${JSON.stringify(invariant?.id)}`);
  semanticIds.add(invariant.id);
  requireEnum(invariant.maturity, baseline.maturityValues, `semantic invariant ${invariant.id} maturity`);
  requireEnum(invariant.visibility, baseline.visibilityValues, `semantic invariant ${invariant.id} visibility`);
  if (typeof invariant.commitment !== "string" || invariant.commitment.trim().length < 20) {
    fail(`semantic invariant ${invariant.id} must contain a meaningful commitment`);
  }
}
if (semanticIds.size === 0) fail("at least one semantic invariant is required");

const sourceIds = new Set();
let totalOperations = 0;
let totalPublicOperations = 0;
const actualDigests = [];

for (const contract of baseline.contractSources ?? []) {
  if (!contract?.id || sourceIds.has(contract.id)) fail(`contract source id is missing or duplicated: ${JSON.stringify(contract?.id)}`);
  sourceIds.add(contract.id);
  if (!contract.source) fail(`contract source ${contract.id} has no source path`);
  if (!Array.isArray(contract.groups) || contract.groups.length === 0) fail(`contract source ${contract.id} has no classification groups`);

  const sourcePath = resolve(root, contract.source);
  const sourceText = await readFile(sourcePath, "utf8");
  const operations = parseOperations(sourceText, contract.source);
  const digest = operationDigest(operations);
  actualDigests.push(`${contract.id}=${digest}`);
  totalOperations += operations.length;

  const groupIds = new Set();
  const compiledGroups = contract.groups.map((group) => {
    if (!group?.id || groupIds.has(group.id)) fail(`group id is missing or duplicated in ${contract.id}: ${JSON.stringify(group?.id)}`);
    groupIds.add(group.id);
    requireEnum(group.maturity, baseline.maturityValues, `${contract.id}/${group.id} maturity`);
    requireEnum(group.visibility, baseline.visibilityValues, `${contract.id}/${group.id} visibility`);
    if (!group.operationPattern) fail(`${contract.id}/${group.id} has no operationPattern`);
    let regex;
    try {
      regex = new RegExp(group.operationPattern);
    } catch (error) {
      fail(`${contract.id}/${group.id} has invalid operationPattern: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...group, regex };
  });

  for (const operation of operations) {
    const matches = compiledGroups.filter((group) => group.regex.test(operation));
    if (matches.length !== 1) {
      fail(`${contract.id} operation ${operation} must match exactly one classification group; matched ${matches.map((group) => group.id).join(", ") || "none"}`);
    }
    if (matches[0].visibility === "public") totalPublicOperations += 1;
  }

  if (contract.operationSetSha256 !== digest) {
    fail(`${contract.id} operation set changed or is not initialized. Expected ${JSON.stringify(contract.operationSetSha256)}, actual ${digest}. Review the operation/classification diff, then update the baseline digest deliberately.`);
  }
}

if (sourceIds.size === 0) fail("at least one code-owned contract source is required");
if (totalPublicOperations === 0) fail("baseline unexpectedly contains zero public operations");

const stableLocks = baseline.stableLocks ?? {};
for (const invariantId of stableLocks.semanticInvariants ?? []) {
  const invariant = (baseline.semanticInvariants ?? []).find((entry) => entry.id === invariantId);
  if (!invariant) fail(`stable lock references missing semantic invariant ${invariantId}`);
  if (invariant.maturity !== "stable") fail(`stable semantic invariant ${invariantId} cannot be downgraded while its stable lock remains`);
}
for (const reference of stableLocks.operationGroups ?? []) {
  const [sourceId, groupId] = String(reference).split("/");
  const source = (baseline.contractSources ?? []).find((entry) => entry.id === sourceId);
  const group = source?.groups?.find((entry) => entry.id === groupId);
  if (!group) fail(`stable lock references missing operation group ${reference}`);
  if (group.maturity !== "stable") fail(`stable operation group ${reference} cannot be downgraded while its stable lock remains`);
}

console.log(`[contract-stability] verified ${semanticIds.size} semantic invariants, ${sourceIds.size} contract sources, ${totalOperations} operations (${totalPublicOperations} public)`);
for (const digest of actualDigests) console.log(`[contract-stability] ${digest}`);

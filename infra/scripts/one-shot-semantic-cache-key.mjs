import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const write = (path, content) => writeFile(resolve(root, path), content, "utf8");

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) throw new Error(`Missing anchor: ${label}`);
  if (text.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous anchor: ${label}`);
  return text.slice(0, first) + after + text.slice(first + before.length);
}

async function replaceFile(path, before, after, label = path) {
  await write(path, replaceOnce(await read(path), before, after, label));
}

// Kernel representation contract: model semantic identity alone is not a cross-Kernel wire cache key.
{
  const path = "apps/core/openapi.yaml";
  const document = JSON.parse(await read(path));
  if (document.info?.version !== "0.33.0") throw new Error(`Expected Kernel 0.33.0, found ${document.info?.version}`);
  const route = document.paths?.["/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"]?.get;
  const before = "The successful body contains no membership, Grant, Delegation or effective-access state and is stable for the returned (key, version, schemaHash), so an authorized client may cache that semantic body independently of the Space.";
  const after = "The successful body contains no membership, Grant, Delegation or effective-access state and is stable for the returned (key, version, schemaHash) within one Kernel contract representation. An authorized client may cache that semantic body independently of the Space; caches reused across Kernel deployments must additionally key by the Kernel contractVersion.";
  route.description = replaceOnce(route.description, before, after, "Kernel semantic-detail cache contract");
  await write(path, JSON.stringify(document));
}

await replaceFile(
  "docs/generic-consumer-m1-static-projection-audit.md",
  "A cached static detail by `(key, version, schemaHash)` is safe as semantic metadata; a cached positive visibility/access edge is never execution authority.",
  "A cached static detail by `(Kernel contractVersion, key, version, schemaHash)` is safe as semantic metadata; `contractVersion` belongs to the Kernel representation layer, while the remaining tuple identifies the published model semantics. A cached positive visibility/access edge is never execution authority.",
  "M1 cache-key rule",
);

await replaceFile(
  "docs/generic-consumer-m2-dynamic-authority-audit.md",
  "- static model semantic detail keyed by `(key, version, schemaHash)`;",
  "- static model semantic detail keyed by `(Kernel contractVersion, key, version, schemaHash)` when caches may survive a Kernel deployment;",
  "M2 cache-key rule",
);

{
  const path = "docs/contracts.md";
  let text = await read(path);
  const paragraph = "Core Kernel `0.33.0` adds canonical structural `timeRanges` to progressive single-model semantic detail. Model-declared ranges and Calendar-derived timed/all-day ranges are projected from their authoritative semantic sources; the projection does not itself introduce overlap/interval query syntax. The Model Control Plane remains independently versioned because its `ModelDefinition` wire envelope deliberately delegates detailed DSL semantics to the normative Model Definition specification and validator.";
  const replacement = paragraph + " Because progressive semantic detail is a Kernel wire representation, a cache that may survive Kernel deployment must use `(Kernel contractVersion, key, version, schemaHash)` rather than treating the model semantic tuple alone as a cross-version representation identity.";
  text = replaceOnce(text, paragraph, replacement, "0.33 contract cache clarification");
  await write(path, text);
}

console.log("Semantic detail cache-key clarification applied.");

import fs from "node:fs";

function rewrite(path, transform) {
  const current = fs.readFileSync(path, "utf8");
  const next = transform(current);
  if (next === current) throw new Error(`Expected cleanup change missing in ${path}`);
  fs.writeFileSync(path, next, "utf8");
}

rewrite("apps/core/scripts/check-openapi.mjs", (current) => {
  const start = current.indexOf('const creationDraft = document.paths?.["/api/v1/spaces/{spaceId}/creation-drafts"]?.post;');
  const processing = current.indexOf('if (!schemas.CreationDraftProcessing?.required?.includes("modelContractRevision")) {', start);
  const end = current.indexOf("\n}\n", processing);
  if (start < 0 || processing < 0 || end < 0) throw new Error("Retired Creation Draft contract assertion block not found");
  return `${current.slice(0, start)}${current.slice(end + 3)}`;
});

rewrite("apps/core/scripts/check-person-directory-openapi.mjs", (current) => current
  .replace('document.info?.version !== "0.47.0"', 'document.info?.version !== "0.48.0"')
  .replace('Person Directory requires Core Kernel 0.47.0', 'Person Directory requires Core Kernel 0.48.0'));

rewrite("apps/core/test/final-migration-state.integration.test.ts", (current) => current.replace(
  'expect(row?.value).toBe("52");',
  'expect(row?.value).toBe("53");',
));

rewrite("apps/core/AGENTS.md", (current) => current.replace(
  "current Kernel version: 0.47.0",
  "current Kernel version: 0.48.0",
));

rewrite("docs/contract-stability-baseline.json", (current) => current.replace(
  "sha256:4a1c2c1dfd39a9b31efbafe826ca4430c83af7f392644d2c35319261d6359e72",
  "sha256:419788e729c03f79bba4c4915e495bcda544be1adbb995db90c03e602fe11a54",
));

rewrite("docs/architecture.md", (current) => current.replace(
  "explicit product-facing Space / Grant / Runtime Discovery / Change History / Creation Draft primitives",
  "explicit product-facing Space / Grant / Runtime Discovery / Change History primitives",
));

rewrite("docs/contracts.md", (current) => current.replace("- Registry-driven Creation Draft orchestration;\n", ""));

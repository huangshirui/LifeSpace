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

rewrite("docs/architecture.md", (current) => current.replace(
  "explicit product-facing Space / Grant / Runtime Discovery / Change History / Creation Draft primitives",
  "explicit product-facing Space / Grant / Runtime Discovery / Change History primitives",
));

rewrite("docs/contracts.md", (current) => current.replace("- Registry-driven Creation Draft orchestration;\n", ""));

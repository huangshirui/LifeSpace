import { readFile, writeFile } from "node:fs/promises";

const file = "infra/scripts/initialize-staging-runtime.mjs";
let source = await readFile(file, "utf8");

function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Expected addon patch target not found: ${before.slice(0, 100)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Addon patch target is not unique: ${before.slice(0, 100)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  `await wranglerSecretBulk("apps/identity", {\n  BOOTSTRAP_SECRET: bootstrapSecret,\n});\nconsole.log("Staging bootstrap secret synchronized and activated");`,
  `await wranglerSecretBulk("apps/identity", {\n  BOOTSTRAP_SECRET: bootstrapSecret,\n});\nconsole.log("Staging bootstrap secret synchronized and activated");\n\n// Identity 0.2 adds user-token verification at the Identity resource server.\n// Rotate the staging-only pair once per staging deployment so Identity and Core\n// are guaranteed to share the same active public key before profile smoke tests.\nawait rotateSigningKeys();`,
);

replaceOnce(
  "let rotatedSigningKeys = false;",
  "let rotatedSigningKeys = true;",
);

await writeFile(file, source);
console.log("Phase 2 profile/assets staging signing-key addon applied");

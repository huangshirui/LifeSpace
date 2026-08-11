import fs from "node:fs/promises";

const file = "infra/scripts/phase2-creation-drafts-finalize.mjs";
const source = await fs.readFile(file, "utf8");
const fixed = source.replaceAll("${coreBase}", "\\${coreBase}");
if (fixed === source) throw new Error("Creation-draft staging interpolation fix found no targets");
await fs.writeFile(file, fixed);
console.log("Creation-draft staging interpolation fixed");

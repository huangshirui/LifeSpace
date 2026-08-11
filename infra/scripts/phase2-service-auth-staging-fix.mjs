import fs from "node:fs/promises";

const file = "infra/scripts/phase2-service-auth-staging-patch.mjs";
const source = await fs.readFile(file, "utf8");
const fixed = source.replaceAll("\\\\${", "\\${");
if (fixed === source) throw new Error("Service-auth staging interpolation fix found no targets");
await fs.writeFile(file, fixed);
console.log("Service-auth staging finalizer interpolation fixed");

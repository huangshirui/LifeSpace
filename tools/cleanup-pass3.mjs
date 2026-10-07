import fs from "node:fs";

const path = "apps/core/wrangler.jsonc";
const current = fs.readFileSync(path, "utf8");
const next = current.replace(/"placement": \{\n\s+"mode": "smart"\n\s+\}/gu, '"placement": { "mode": "smart" }');

if (next === current) {
  throw new Error("Expected formatted Smart Placement blocks were not found");
}

fs.writeFileSync(path, next, "utf8");

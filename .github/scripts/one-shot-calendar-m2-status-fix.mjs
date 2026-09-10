import fs from "node:fs";

const path = "apps/core/scripts/check-openapi.mjs";
const before = fs.readFileSync(path, "utf8");
const oldText = 'if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.34.0") {';
const newText = 'if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.35.0") {';
const first = before.indexOf(oldText);
if (first < 0 || before.indexOf(oldText, first + oldText.length) >= 0) {
  throw new Error("Kernel status-version assertion anchor missing or duplicated");
}
fs.writeFileSync(path, `${before.slice(0, first)}${newText}${before.slice(first + oldText.length)}`);
console.log("Calendar M2 status-version check migration completed");

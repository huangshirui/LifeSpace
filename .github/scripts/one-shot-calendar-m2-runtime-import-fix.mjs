import fs from "node:fs";

const path = "apps/core/src/calendar-query.ts";
let text = fs.readFileSync(path, "utf8");
const replacements = [
  ["CALENDAR_CALENDAR_LEGACY_WINDOW_PARAMETERS", "CALENDAR_LEGACY_WINDOW_PARAMETERS"],
  ["CALENDAR_VIEWING_WINDOW_PARAMETER_NAMES", "CALENDAR_VIEWING_WINDOW_PARAMETERS"],
];
for (const [oldText, newText] of replacements) {
  if (!text.includes(oldText)) throw new Error(`Calendar descriptor import fix anchor missing: ${oldText}`);
  text = text.replaceAll(oldText, newText);
}
fs.writeFileSync(path, text);
console.log("Calendar M2 descriptor import migration completed");

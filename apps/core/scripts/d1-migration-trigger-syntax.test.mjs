import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");

test("remote D1 migrations parenthesize CASE expressions inside trigger bodies", () => {
  const violations = [];

  for (const name of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith(".sql")).sort()) {
    const lines = readFileSync(resolve(MIGRATIONS_DIR, name), "utf8").split(/\r?\n/u);
    let inTrigger = false;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^\s*CREATE\s+TRIGGER\b/iu.test(line)) inTrigger = true;

      // Cloudflare D1's remote statement splitter can mistake the END token of
      // an unparenthesized SELECT CASE ... END expression for the trigger END,
      // producing SQLITE_ERROR 7500 ("incomplete input"). Parenthesizing the
      // CASE expression avoids that remote-only parser ambiguity.
      if (inTrigger && /^\s*SELECT\s+CASE\b/iu.test(line)) {
        violations.push(`${name}:${index + 1}`);
      }

      if (inTrigger && /^\s*END\s*;\s*$/iu.test(line)) inTrigger = false;
    }
  }

  assert.deepEqual(
    violations,
    [],
    `D1-unsafe unparenthesized SELECT CASE found in trigger bodies: ${violations.join(", ")}`,
  );
});

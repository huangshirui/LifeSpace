import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const NORMATIVE_ID = /^MDV1-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{2}$/u;
const FIXTURE_ID = /^ORC-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{2}$/u;

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

export function validateModelDefinitionConformance(specText, oracleSources) {
  const errors = [];
  const normativeIds = [];

  for (const [index, line] of specText.split(/\r?\n/u).entries()) {
    if (!line.includes("Conformance-ID:")) continue;
    const match = /^Conformance-ID:\s+(\S+)\s*$/u.exec(line);
    if (!match || !NORMATIVE_ID.test(match[1])) {
      errors.push(`Malformed Conformance-ID at spec line ${index + 1}: ${line.trim()}`);
      continue;
    }
    normativeIds.push(match[1]);
  }

  for (const id of duplicateValues(normativeIds)) errors.push(`Duplicate normative Conformance-ID: ${id}`);

  const fixtures = [];
  for (const source of oracleSources) {
    const lines = source.text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.includes("Oracle-Fixture:")) continue;
      const fixtureMatch = /^\s*\/\/ Oracle-Fixture:\s+(\S+)\s*$/u.exec(line);
      if (!fixtureMatch || !FIXTURE_ID.test(fixtureMatch[1])) {
        errors.push(`Malformed Oracle-Fixture at ${source.path}:${index + 1}: ${line.trim()}`);
        continue;
      }
      const coversLine = lines[index + 1] ?? "";
      const coversMatch = /^\s*\/\/ Covers:\s+(.+?)\s*$/u.exec(coversLine);
      if (!coversMatch) {
        errors.push(`Oracle fixture ${fixtureMatch[1]} at ${source.path}:${index + 1} must be followed by // Covers: ...`);
        continue;
      }
      const covers = coversMatch[1].split(",").map((value) => value.trim()).filter(Boolean);
      if (!covers.length || covers.some((id) => !NORMATIVE_ID.test(id))) {
        errors.push(`Oracle fixture ${fixtureMatch[1]} has malformed Covers metadata`);
        continue;
      }
      if (duplicateValues(covers).length) errors.push(`Oracle fixture ${fixtureMatch[1]} repeats a covered Conformance-ID`);
      fixtures.push({ id: fixtureMatch[1], covers, source: source.path, line: index + 1 });
    }
  }

  for (const id of duplicateValues(fixtures.map((fixture) => fixture.id))) errors.push(`Duplicate Oracle fixture id: ${id}`);

  const normativeSet = new Set(normativeIds);
  const covered = new Set();
  for (const fixture of fixtures) {
    for (const id of fixture.covers) {
      if (!normativeSet.has(id)) errors.push(`Oracle fixture ${fixture.id} references unknown Conformance-ID ${id}`);
      else covered.add(id);
    }
  }
  for (const id of normativeSet) {
    if (!covered.has(id)) errors.push(`Normative Conformance-ID has no Oracle fixture coverage: ${id}`);
  }

  if (!normativeIds.length) errors.push("No normative Conformance-ID markers found in Model Definition specification");
  if (!fixtures.length) errors.push("No Oracle-Fixture markers found in Core tests");

  return { errors, normativeIds: [...normativeSet].sort(), fixtures };
}

async function oracleFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await oracleFiles(target));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      const text = await readFile(target, "utf8");
      if (text.includes("Oracle-Fixture:")) result.push({ path: path.relative(process.cwd(), target), text });
    }
  }
  return result;
}

async function main() {
  const root = process.cwd();
  const specPath = path.join(root, "docs/model-definition-spec.md");
  const specText = await readFile(specPath, "utf8");
  const sources = await oracleFiles(path.join(root, "apps/core/test"));
  const result = validateModelDefinitionConformance(specText, sources);
  if (result.errors.length) {
    console.error("Model Definition conformance coverage check failed:\n" + result.errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Model Definition conformance coverage OK: ${result.normativeIds.length} normative IDs, ${result.fixtures.length} Oracle fixtures.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

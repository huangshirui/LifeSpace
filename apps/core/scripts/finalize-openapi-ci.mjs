import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const branch = process.env.GITHUB_HEAD_REF;

if (process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("This one-time finalizer must run in GitHub Actions.");
}

if (branch !== "agent/phase2-wishes") {
  throw new Error(`Refusing to finalize OpenAPI from unexpected PR branch: ${branch ?? "<none>"}`);
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    stdio: "inherit",
    ...options,
  });
}

// The pull_request checkout is a synthetic merge ref. Switch back to the real
// PR head before generating or committing so the final commit remains a clean
// descendant of agent/phase2-wishes rather than recording the synthetic merge.
run("git", ["fetch", "origin", branch]);
run("git", ["checkout", "-f", "-B", branch, `origin/${branch}`]);

run(process.execPath, ["scripts/generate-openapi-wishes-finalize.mjs"], { cwd: "apps/core" });
run(process.execPath, ["scripts/check-openapi.mjs"], { cwd: "apps/core" });

const packagePath = "apps/core/package.json";
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
packageJson.scripts.contract = "node scripts/check-openapi.mjs";
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

rmSync("apps/core/scripts/generate-openapi-wishes-finalize.mjs");
rmSync("apps/core/scripts/print-openapi-finalize.mjs");
rmSync("apps/core/scripts/finalize-openapi-ci.mjs");

// Validate the exact canonical file that will be committed, with no generator
// left in the contract path.
run(process.execPath, ["scripts/check-openapi.mjs"], { cwd: "apps/core" });

run("git", ["config", "user.name", "github-actions[bot]"]);
run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
run("git", [
  "add",
  "apps/core/openapi.yaml",
  "apps/core/package.json",
  "apps/core/scripts/generate-openapi-wishes-finalize.mjs",
  "apps/core/scripts/print-openapi-finalize.mjs",
  "apps/core/scripts/finalize-openapi-ci.mjs",
]);

run("git", ["diff", "--cached", "--check"]);
run("git", ["commit", "-m", "docs(core): finalize Wishes OpenAPI 0.7.0"]);
run("git", ["push", "origin", `HEAD:${branch}`]);

console.log("Finalized canonical Core OpenAPI 0.7.0 on the PR branch.");

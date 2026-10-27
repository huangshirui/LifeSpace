// Issue #93: a ratcheting inventory, not an authorization mechanism.
// Bootstrap is currently an exceptional trust root. Every existing use must
// shrink by migration; no new production/runtime consumers may be added.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOOTSTRAP_REFERENCE = "/bootstrap/v1/";
export const SOURCE_ROOTS = Object.freeze([
  ".github/workflows",
  "apps/identity/src",
  "apps/console/scripts",
  "apps/console/worker",
  "infra/scripts",
]);

// Upper bounds are the actual 2026-10-27 main-branch counts. Decreases are
// allowed. Increases (including in an already allowlisted file) fail CI.
export const LEGACY_REFERENCE_BUDGET = Object.freeze({
  "apps/identity/src/app.ts": { category: "initial-seed", max: 1 },
  "apps/identity/src/platform-admin-assignment.ts": { category: "seed-recovery", max: 3 },
  "apps/identity/src/application-admin.ts": { category: "duplicated-route", max: 5 },
  "apps/identity/src/access-identity.ts": { category: "duplicated-route", max: 3 },
  "infra/scripts/prepare-staging-console-shell.mjs": { category: "provisioning", max: 5 },
  "infra/scripts/prepare-production-console-admin.mjs": { category: "provisioning", max: 8 },
  "infra/scripts/finalize-production-console-admin.mjs": { category: "provisioning", max: 2 },
  "infra/scripts/prepare-staging-console-admin.mjs": { category: "provisioning", max: 6 },
  "infra/scripts/resolve-production-console-admin.mjs": { category: "recovery", max: 2 },
  "apps/console/scripts/verify-staging-control-plane.mjs": { category: "staging-acceptance", max: 3 },
  "infra/scripts/verify-staging-application-admin.mjs": { category: "staging-acceptance", max: 1 },
  "infra/scripts/verify-staging-agent-ready.mjs": { category: "staging-acceptance", max: 4 },
  "infra/scripts/prepare-staging-smoke.mjs": { category: "staging-seed", max: 1 },
  "apps/console/scripts/verify-staging-space-governance.mjs": { category: "staging-acceptance", max: 3 },
  "infra/scripts/verify-production-model-admin.mjs": { category: "production-acceptance", max: 1 },
  "apps/console/scripts/check-production-deploy-isolation.mjs": { category: "static-guard-only", max: 1 },
  "apps/console/scripts/verify-staging-configuration-center.mjs": { category: "staging-acceptance", max: 3 },
  ".github/workflows/lifespace-console-staging-provision.yml": { category: "provisioning", max: 2 },
});

// This set is a *ceiling*. Routes may disappear after callers migrate;
// new bootstrap endpoints and variants must not be introduced.
export const LEGACY_ROUTE_BUDGET = Object.freeze([
  "POST /bootstrap/v1/applications",
  "GET /bootstrap/v1/applications/:applicationId",
  "PATCH /bootstrap/v1/applications/:applicationId",
  "GET /bootstrap/v1/applications/:applicationId/credentials",
  "POST /bootstrap/v1/applications/:applicationId/credentials",
  "DELETE /bootstrap/v1/applications/:applicationId/credentials/:credentialId",
  "GET /bootstrap/v1/applications/:applicationId/access-audiences",
  "POST /bootstrap/v1/applications/:applicationId/access-audiences",
  "DELETE /bootstrap/v1/applications/:applicationId/access-audiences/:audienceId",
  "GET /bootstrap/v1/platform-administrators",
  "PUT /bootstrap/v1/platform-administrators/:userId",
  "DELETE /bootstrap/v1/platform-administrators/:userId",
]);

const ROUTE_RE = /\bapp\.(get|post|put|patch|delete)\(\s*["'\x60](\/bootstrap\/v1\/[^"'\x60]+)["'\x60]/gu;
const TRACKED_SOURCE_RE = /\.(?:mjs|ts|yml|yaml)$/u;
const EXCLUDED_SOURCE_RE = /(?:^|\/)(?:[^/]+\.(?:test|spec)\.[cm]?[jt]s|bootstrap-surface-inventory(?:\.test)?\.mjs)$/u;

export function inspectBootstrapSurface(files) {
  const allowed = new Set(LEGACY_ROUTE_BUDGET);
  const observedRoutes = new Set();
  const observedFiles = [];
  let totalReferences = 0;
  for (const { path, source } of files) {
    const count = source.split(BOOTSTRAP_REFERENCE).length - 1;
    if (!count) continue;
    const entry = LEGACY_REFERENCE_BUDGET[path];
    if (!entry) throw new Error("Unapproved Bootstrap consumer: " + path);
    if (count > entry.max) {
      throw new Error("Bootstrap reference budget exceeded: " + path + " (" + count + " > " + entry.max + ")");
    }
    observedFiles.push({ path, category: entry.category, count });
    totalReferences += count;
    if (path.startsWith("apps/identity/src/")) {
      for (const match of source.matchAll(ROUTE_RE)) {
        const route = match[1].toUpperCase() + " " + match[2];
        if (!allowed.has(route)) throw new Error("Unapproved Bootstrap API route: " + route);
        if (observedRoutes.has(route)) throw new Error("Duplicate Bootstrap API route: " + route);
        observedRoutes.add(route);
      }
    }
  }
  return {
    files: observedFiles.sort((a, b) => a.path.localeCompare(b.path)),
    routes: [...observedRoutes].sort(),
    totalReferences,
  };
}

export function collectBootstrapSources(repoRoot) {
  const files = [];
  function walk(base) {
    if (!existsSync(base)) throw new Error("Missing Bootstrap inventory source directory: " + base);
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const path = relative(repoRoot, full).replaceAll("\\", "/");
        if (!TRACKED_SOURCE_RE.test(path) || EXCLUDED_SOURCE_RE.test(path)) continue;
        const source = readFileSync(full, "utf8");
        if (source.includes(BOOTSTRAP_REFERENCE)) files.push({ path, source });
      }
    }
  }
  for (const path of SOURCE_ROOTS) walk(resolve(repoRoot, path));
  return files;
}

export function checkBootstrapSurface(repoRoot) {
  return inspectBootstrapSurface(collectBootstrapSources(repoRoot));
}

const executedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) {
  const repoRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const report = checkBootstrapSurface(repoRoot);
  console.log(JSON.stringify({
    ok: true,
    issue: 93,
    mode: "ratchet-only",
    activeSourceFiles: report.files.length,
    activeRouteCount: report.routes.length,
    totalBootstrapReferences: report.totalReferences,
    note: "This check prevents expansion; it does not assert that legacy Bootstrap callers are safe.",
  }, null, 2));
}

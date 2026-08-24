import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const script = readFileSync(new URL("./prepare-production-homemew-web.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/homemew-web-production-provision.yml", import.meta.url), "utf8");

function mapBlock(name) {
  return script.match(new RegExp(`const ${name} = new Map\\(\\[([\\s\\S]*?)\\]\\);`, "u"))?.[1] ?? "";
}

test("production provisioning is hard-gated to production resources and explicit confirmation", () => {
  assert.match(script, /https:\/\/auth\.aisr\.online/u);
  assert.match(script, /https:\/\/core\.aisr\.online/u);
  assert.match(script, /lifespace-core/u);
  assert.match(script, /homemew-web-production/u);
  assert.match(script, /app_homemew_web_production/u);
  assert.match(script, /app_homemew_integrations_production/u);
  assert.match(script, /PROVISION_HOMEMEW_WEB_PRODUCTION/u);
  assert.match(script, /environment !== "production"/u);
  assert.doesNotMatch(script, /auth-staging\.aisr\.online/u);
  assert.doesNotMatch(script, /lifespace-core-staging/u);
  assert.doesNotMatch(script, /homemew-web-staging/u);
});

test("production browser model ceiling includes all HomeMew Web models", () => {
  const block = mapBlock("WEB_MODEL_ACCESS");
  assert.match(block, /\["event", "write"\]/u);
  assert.match(block, /\["task", "write"\]/u);
  assert.match(block, /\["day_record", "write"\]/u);
  assert.match(block, /\["wish", "write"\]/u);
});

test("production integrations ceiling remains intentionally narrower and excludes wish", () => {
  const block = mapBlock("INTEGRATIONS_MODEL_ACCESS");
  assert.match(block, /\["event", "write"\]/u);
  assert.match(block, /\["task", "write"\]/u);
  assert.match(block, /\["day_record", "write"\]/u);
  assert.doesNotMatch(block, /wish/u);
  assert.match(script, /const INTEGRATIONS_SCOPES = \["resources:read", "resources:write"\]/u);
});

test("production provisioning requires the Web, session and integrations Worker secrets", () => {
  assert.match(script, /"LIFESPACE_APPLICATION_CREDENTIAL"/u);
  assert.match(script, /"WEB_SESSION_SECRET"/u);
  assert.match(script, /"LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL"/u);
  assert.match(script, /crypto\.randomBytes\(48\)/u);
});

test("production provisioning verifies Access root and exact public Mini Program login bypass", () => {
  assert.match(script, /const loginPath = "\/api\/v1\/login\/wechat"/u);
  assert.match(script, /decision === "allow"/u);
  assert.match(script, /decision === "bypass"/u);
  assert.match(script, /entry\?\.everyone/u);
});

test("production workflow is manual, protected by the GitHub production environment and runs the guarded script", () => {
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /LIFESPACE_PRODUCTION_BOOTSTRAP_SECRET/u);
  assert.match(workflow, /PROVISION_HOMEMEW_WEB_PRODUCTION/u);
  assert.match(workflow, /node infra\/scripts\/prepare-production-homemew-web\.mjs/u);
  assert.doesNotMatch(workflow, /branches:\s*\n\s*- main/u);
});

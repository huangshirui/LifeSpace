import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const integrationScript = readFileSync(new URL("./prepare-staging-homemew-web-integrations.mjs", import.meta.url), "utf8");
const webAccessScript = readFileSync(new URL("./prepare-staging-web-access.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/homemew-web-staging-provision.yml", import.meta.url), "utf8");

test("HomeMew Web application ceiling includes on-demand Data Grant management", () => {
  assert.match(webAccessScript, /"grants:manage"/u);
  assert.match(integrationScript, /const WEB_MANAGER_SCOPE = "grants:manage"/u);
});

test("Web Access provisioning accepts compatible Identity schema upgrades", () => {
  assert.match(webAccessScript, /const MINIMUM_SCHEMA = 5/u);
  assert.match(webAccessScript, /schemaVersion < MINIMUM_SCHEMA/u);
  assert.doesNotMatch(webAccessScript, /String\(data\?\.schemaVersion\) !== REQUIRED_SCHEMA/u);
});

test("dedicated HomeMew integrations application is limited to resource read and write", () => {
  assert.match(integrationScript, /app_homemew_integrations_staging/u);
  assert.match(integrationScript, /const INTEGRATIONS_SCOPES = \["resources:read", "resources:write"\]/u);
  assert.doesNotMatch(integrationScript, /INTEGRATIONS_SCOPES[^\n]*grants:manage/u);
  assert.doesNotMatch(integrationScript, /INTEGRATIONS_SCOPES[^\n]*spaces:manage/u);
});

test("W4 platform model ceiling stays on event task and day_record only", () => {
  const modelBlock = integrationScript.match(/const MODEL_ACCESS = new Map\(\[([\s\S]*?)\]\);/u)?.[1] ?? "";
  assert.match(modelBlock, /\["event", "write"\]/u);
  assert.match(modelBlock, /\["task", "write"\]/u);
  assert.match(modelBlock, /\["day_record", "write"\]/u);
  assert.doesNotMatch(modelBlock, /wish/u);
});

test("provisioning targets staging resources and installs the dedicated Worker secret", () => {
  assert.match(integrationScript, /auth-staging\.aisr\.online/u);
  assert.match(integrationScript, /lifespace-core-staging/u);
  assert.match(integrationScript, /homemew-web-staging/u);
  assert.match(integrationScript, /LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL/u);
  assert.match(integrationScript, /environment !== "staging"/u);
  assert.doesNotMatch(integrationScript, /https:\/\/auth\.aisr\.online/u);
  assert.doesNotMatch(integrationScript, /lifespace-core"/u);
});

test("official HomeMew Web staging workflow runs W4 provisioning and verifies all three secrets", () => {
  assert.match(workflow, /node infra\/scripts\/prepare-staging-homemew-web-integrations\.mjs/u);
  assert.match(workflow, /LIFESPACE_INTEGRATIONS_APPLICATION_CREDENTIAL/u);
  assert.match(workflow, /LIFESPACE_APPLICATION_CREDENTIAL/u);
  assert.match(workflow, /WEB_SESSION_SECRET/u);
  assert.match(workflow, /Production resources\/routes: untouched/u);
});

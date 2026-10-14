import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deploymentSettings, bindProvider, validateProviderProfile, validateLiveBindings, adapterWranglerCommands } from "./external-provider-deployment.mjs";

const environment = () => ({
  LIFESPACE_EXTERNAL_PROVIDER_ENABLED: "1",
  LIFESPACE_EXTERNAL_ADAPTER_WORKER: "synthetic-provider-staging",
  EXTERNAL_ADAPTER_SHARED_SECRET: "synthetic-independent-shared-secret-value",
  NOTION_CONNECTIONS: JSON.stringify({ smoke: { token: "synthetic-token", read: true, write: true } }),
  LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF: "smoke",
  LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID: "10000000000000000000000000000001",
  LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED: "1",
});
test("enabled staging validates full synthetic provider prerequisites; disabled remains optional", () => {
  assert.equal(deploymentSettings({}, "production").enabled, false);
  assert.equal(deploymentSettings(environment(), "staging").enabled, true);
  assert.throws(() => deploymentSettings({}, "local"));
  for (const [key, value] of Object.entries({ LIFESPACE_EXTERNAL_PROVIDER_ENABLED: "yes", LIFESPACE_EXTERNAL_ADAPTER_WORKER: "synthetic-production", EXTERNAL_ADAPTER_SHARED_SECRET: "short", NOTION_CONNECTIONS: "null", LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF: "missing", LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID: "bad", LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED: "0" })) {
    assert.throws(() => deploymentSettings({ ...environment(), [key]: value }, "staging"), key);
  }
  for (const connections of [[], {}, { smoke: { token: "sensitive-synthetic-value", read: true, write: false } }, { smoke: { token: "sensitive-synthetic-value", read: true, write: true, disabled: true } }]) {
    assert.throws(() => deploymentSettings({ ...environment(), NOTION_CONNECTIONS: JSON.stringify(connections) }, "staging"), error => !error.message.includes("sensitive-synthetic-value"));
  }
  assert.throws(() => deploymentSettings({ ...environment(), LIFESPACE_STAGING_BOOTSTRAP_SECRET: environment().EXTERNAL_ADAPTER_SHARED_SECRET }, "staging"));
  assert.throws(() => deploymentSettings(environment(), "production"));
  assert.throws(() => deploymentSettings({ ...environment(), EXTERNAL_ADAPTER_SHARED_SECRET: "x".repeat(32) + "\n" }, "staging"));
  assert.throws(() => deploymentSettings({ ...environment(), NOTION_CONNECTIONS: JSON.stringify({ smoke: { token: "synthetic\ntoken", read: true, write: true } }) }, "staging"));
});
test("optional Core binding preserves opposite environment and all platform bindings", () => {
  const config = JSON.parse(readFileSync(new URL("../../apps/core/wrangler.jsonc", import.meta.url), "utf8"));
  const settings = deploymentSettings(environment(), "staging");
  const bound = bindProvider(config, settings);
  assert.deepEqual(bound.env.production, config.env.production);
  assert.deepEqual(bound.env.staging.services, [...config.env.staging.services, { binding: "EXTERNAL_ADAPTER", service: settings.worker }]);
  assert.deepEqual(bindProvider(bound, settings), bound);
  assert.deepEqual(bindProvider(bound, deploymentSettings({}, "staging")), config);
});
test("private profiles and live secret/binding/vault metadata fail closed", () => {
  const profile = {
    workers_dev: false,
    preview_urls: false,
    routes: [],
    durable_objects: { bindings: [{ name: "CONNECTIONS", class_name: "NotionConnectionVault" }] },
  };
  const config = { ...profile, env: { staging: profile } };
  validateProviderProfile(config, "staging");
  assert.throws(() => validateProviderProfile({ ...config, workers_dev: true }, "staging"));
  assert.throws(() => validateProviderProfile({ ...config, env: { staging: { ...profile, durable_objects: { bindings: [] } } } }, "staging"));
  assert.throws(() => validateProviderProfile(config, "production"));
  const settings = deploymentSettings(environment(), "staging");
  const core = { bindings: [{ name: "EXTERNAL_ADAPTER", type: "service", service: settings.worker }, { name: "EXTERNAL_ADAPTER_SHARED_SECRET", type: "secret_text" }, { name: "EXTERNAL_SCHEMA_REFRESH_SECONDS", type: "plain_text", text: "300" }] };
  const adapter = { bindings: [
    ...["EXTERNAL_ADAPTER_SHARED_SECRET", "NOTION_CONNECTIONS"].map(name => ({ name, type: "secret_text" })),
    { name: "CONNECTIONS", type: "durable_object_namespace" },
  ] };
  validateLiveBindings(core, adapter, settings);
  for (let i = 0; i < core.bindings.length; i++) assert.throws(() => validateLiveBindings({ bindings: core.bindings.filter((_, j) => i !== j) }, adapter, settings));
  assert.throws(() => validateLiveBindings(core, { bindings: [] }, settings));
  assert.throws(() => validateLiveBindings(core, { bindings: adapter.bindings.filter(binding => binding.name !== "CONNECTIONS") }, settings));
});
test("Adapter code deploy and secret upload target the same exact Worker name", () => {
  for (const [environmentName, worker] of [["staging", "synthetic-provider-staging"], ["production", "synthetic-provider"]]) {
    const commands = adapterWranglerCommands("/tmp/notion-wrangler.jsonc", environmentName, worker);
    assert.deepEqual(commands.deploy, ["deploy", "--config", "/tmp/notion-wrangler.jsonc", "--env", environmentName, "--name", worker]);
    assert.deepEqual(commands.secrets, ["secret", "bulk", "--config", "/tmp/notion-wrangler.jsonc", "--name", worker]);
    assert.equal(commands.secrets.includes("--env"), false);
  }
});
test("canonical release deploys pinned Adapter before Core and gates provider acceptance", () => {
  const manifest = JSON.parse(readFileSync(new URL("../external-provider.json", import.meta.url), "utf8"));
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.repository, "huangshirui/lifespace-adapters");
  assert.equal(manifest.revision, "85a569df6b5f2305c4a0a42d3762f5bb118944aa");
  assert.ok(readFileSync(new URL("../../.github/workflows/check.yml", import.meta.url), "utf8").includes(`ref: ${manifest.revision}`));
  for (const env of ["staging", "production"]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${env === "staging" ? "staging" : "production"}-deploy.yml`, import.meta.url), "utf8");
    const prepare = workflow.indexOf(`external-provider-deployment.mjs prepare ${env}`);
    const adapter = workflow.indexOf(`external-provider-deployment.mjs deploy-adapter ${env}`);
    const core = workflow.indexOf(`wrangler deploy --env ${env}`);
    assert.ok(prepare >= 0 && prepare < adapter && adapter < core);
    assert.ok(workflow.indexOf(`external-provider-deployment.mjs sync-core ${env}`) > core);
    assert.ok(workflow.includes("ref: ${{ env.LIFESPACE_EXTERNAL_PROVIDER_REVISION }}"));
    assert.ok(workflow.includes(`external-provider-deployment.mjs verify ${env}`));
  }
});

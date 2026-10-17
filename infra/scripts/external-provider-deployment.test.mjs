import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deploymentSettings,
  bindProvider,
  loadProviderManifest,
  validateProviderProfile,
  validateLiveBindings,
  validateLiveCoreBindings,
  adapterWranglerCommands,
} from "./external-provider-deployment.mjs";

const environment = () => ({
  LIFESPACE_EXTERNAL_PROVIDER_ENABLED: "1",
  EXTERNAL_CURSOR_SECRET: "synthetic-core-cursor-secret-value-1234567890",
  LIFESPACE_NOTION_ADAPTER_WORKER: "synthetic-notion-adapter-staging",
  NOTION_ADAPTER_SHARED_SECRET: "synthetic-notion-shared-secret-value-123456",
  NOTION_CONNECTION_VAULT_MASTER_KEY: "22".repeat(32),
  NOTION_SMOKE_TOKEN: "synthetic-notion-smoke-token-value",
  LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID: "10000000000000000000000000000001",
  LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED: "1",
});
const productionEnvironment = () => ({
  LIFESPACE_EXTERNAL_PROVIDER_ENABLED: "1",
  EXTERNAL_CURSOR_SECRET: "synthetic-production-cursor-secret-value-12345",
  LIFESPACE_NOTION_ADAPTER_WORKER: "synthetic-notion-adapter",
  NOTION_ADAPTER_SHARED_SECRET: "synthetic-notion-production-shared-secret-12345",
  NOTION_CONNECTION_VAULT_MASTER_KEY: "33".repeat(32),
});

test("enabled staging validates dynamic-only Provider prerequisites; production needs no smoke credential", () => {
  assert.equal(deploymentSettings({}, "production").enabled, false);
  assert.equal(deploymentSettings(environment(), "staging").enabled, true);
  assert.equal(deploymentSettings(productionEnvironment(), "production").enabled, true);
  assert.throws(() => deploymentSettings({}, "local"));
  for (const [key, value] of Object.entries({
    LIFESPACE_EXTERNAL_PROVIDER_ENABLED: "yes",
    EXTERNAL_CURSOR_SECRET: "short",
    LIFESPACE_NOTION_ADAPTER_WORKER: "synthetic-production",
    NOTION_ADAPTER_SHARED_SECRET: "short",
    NOTION_CONNECTION_VAULT_MASTER_KEY: "short",
    NOTION_SMOKE_TOKEN: "",
    LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID: "bad",
    LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED: "0",
  })) assert.throws(() => deploymentSettings({ ...environment(), [key]: value }, "staging"), key);

  assert.throws(() => deploymentSettings({ ...environment(), LIFESPACE_STAGING_BOOTSTRAP_SECRET: environment().NOTION_ADAPTER_SHARED_SECRET }, "staging"));
  assert.throws(() => deploymentSettings({ ...environment(), LIFESPACE_STAGING_BOOTSTRAP_SECRET: environment().NOTION_CONNECTION_VAULT_MASTER_KEY }, "staging"));
  assert.throws(() => deploymentSettings({ ...environment(), NOTION_ADAPTER_SHARED_SECRET: environment().EXTERNAL_CURSOR_SECRET }, "staging"));
  assert.throws(() => deploymentSettings({ ...environment(), NOTION_CONNECTION_VAULT_MASTER_KEY: "g".repeat(64) }, "staging"));
  assert.throws(() => deploymentSettings({ ...environment(), NOTION_SMOKE_TOKEN: "bad\ntoken" }, "staging"));
  assert.throws(() => deploymentSettings({ ...environment(), NOTION_SMOKE_TOKEN: environment().NOTION_ADAPTER_SHARED_SECRET }, "staging"));
});

test("manifest rejects deployment-managed static credential maps", () => {
  const manifest = loadProviderManifest();
  const invalid = structuredClone(manifest);
  invalid.providers.notion.staticConnectionsEnv = "NOTION_CONNECTIONS";
  assert.throws(() => deploymentSettings(environment(), "staging", invalid));
});

test("Core provider routing is generated from the manifest and removes the legacy generic binding", () => {
  const config = JSON.parse(readFileSync(new URL("../../apps/core/wrangler.jsonc", import.meta.url), "utf8"));
  const settings = deploymentSettings(environment(), "staging");
  const withLegacy = structuredClone(config);
  withLegacy.env.staging.services.push({ binding: "EXTERNAL_ADAPTER", service: "legacy-provider-staging" });
  const bound = bindProvider(withLegacy, settings);
  assert.deepEqual(bound.env.production, config.env.production);
  assert.equal(bound.env.staging.services.some(binding => binding.binding === "EXTERNAL_ADAPTER"), false);
  assert(bound.env.staging.services.some(binding => binding.binding === "EXTERNAL_ADAPTER_NOTION" && binding.service === "synthetic-notion-adapter-staging"));
  assert.equal(bound.env.staging.vars.EXTERNAL_PROVIDER_ROUTES, JSON.stringify({ notion: { binding: "EXTERNAL_ADAPTER_NOTION", sharedSecret: "EXTERNAL_ADAPTER_NOTION_SHARED_SECRET" } }));
  assert.deepEqual(bindProvider(bound, settings), bound);
});

test("manifest supports a second Provider without changing Core business configuration semantics", () => {
  const manifest = loadProviderManifest();
  const multi = structuredClone(manifest);
  multi.providers.airtable = {
    adapterConfig: "adapters/airtable/wrangler.jsonc",
    coreBinding: "EXTERNAL_ADAPTER_AIRTABLE",
    coreSharedSecret: "EXTERNAL_ADAPTER_AIRTABLE_SHARED_SECRET",
    workerEnv: "LIFESPACE_AIRTABLE_ADAPTER_WORKER",
    sharedSecretEnv: "AIRTABLE_ADAPTER_SHARED_SECRET",
    vaultMasterKeyEnv: "AIRTABLE_CONNECTION_VAULT_MASTER_KEY",
    vaultBinding: "CONNECTIONS",
    vaultClass: "AirtableConnectionVault",
  };
  const settings = deploymentSettings({
    ...environment(),
    LIFESPACE_AIRTABLE_ADAPTER_WORKER: "synthetic-airtable-adapter-staging",
    AIRTABLE_ADAPTER_SHARED_SECRET: "synthetic-airtable-shared-secret-value-12345",
    AIRTABLE_CONNECTION_VAULT_MASTER_KEY: "44".repeat(32),
  }, "staging", multi);
  assert.deepEqual(Object.keys(settings.routes).sort(), ["airtable", "notion"]);
  assert.deepEqual(settings.routes.airtable, { binding: "EXTERNAL_ADAPTER_AIRTABLE", sharedSecret: "EXTERNAL_ADAPTER_AIRTABLE_SHARED_SECRET" });
  assert.equal(settings.providers.find(provider => provider.key === "airtable")?.worker, "synthetic-airtable-adapter-staging");
});

test("private Provider profiles and live routed Core/Adapter metadata fail closed", () => {
  const settings = deploymentSettings(environment(), "staging");
  const provider = settings.providers[0];
  const profile = {
    workers_dev: false,
    preview_urls: false,
    routes: [],
    durable_objects: { bindings: [{ name: "CONNECTIONS", class_name: "NotionConnectionVault" }] },
  };
  const config = { ...profile, env: { staging: profile } };
  validateProviderProfile(config, "staging", provider);
  assert.throws(() => validateProviderProfile({ ...config, workers_dev: true }, "staging", provider));
  assert.throws(() => validateProviderProfile({ ...config, env: { staging: { ...profile, durable_objects: { bindings: [] } } } }, "staging", provider));

  const core = { bindings: [
    { name: "EXTERNAL_CURSOR_SECRET", type: "secret_text" },
    { name: "EXTERNAL_SCHEMA_REFRESH_SECONDS", type: "plain_text", text: "300" },
    { name: "EXTERNAL_PROVIDER_ROUTES", type: "plain_text", text: JSON.stringify(settings.routes) },
    { name: "EXTERNAL_ADAPTER_NOTION", type: "service", service: provider.worker },
    { name: "EXTERNAL_ADAPTER_NOTION_SHARED_SECRET", type: "secret_text" },
  ] };
  const adapter = { bindings: [
    ...["EXTERNAL_ADAPTER_SHARED_SECRET", "CONNECTION_VAULT_MASTER_KEY"].map(name => ({ name, type: "secret_text" })),
    { name: "CONNECTIONS", type: "durable_object_namespace" },
  ] };
  validateLiveBindings(core, adapter, settings, provider);
  assert.throws(() => validateLiveCoreBindings({ bindings: [...core.bindings, { name: "EXTERNAL_ADAPTER", type: "service", service: "legacy" }] }, settings));
  for (const required of ["EXTERNAL_CURSOR_SECRET", "EXTERNAL_PROVIDER_ROUTES", "EXTERNAL_ADAPTER_NOTION", "EXTERNAL_ADAPTER_NOTION_SHARED_SECRET"])
    assert.throws(() => validateLiveBindings({ bindings: core.bindings.filter(binding => binding.name !== required) }, adapter, settings, provider));
  for (const required of ["EXTERNAL_ADAPTER_SHARED_SECRET", "CONNECTION_VAULT_MASTER_KEY", "CONNECTIONS"])
    assert.throws(() => validateLiveBindings(core, { bindings: adapter.bindings.filter(binding => binding.name !== required) }, settings, provider));
});

test("Adapter code deploy and secret upload target the same exact Worker name", () => {
  for (const [environmentName, worker] of [["staging", "synthetic-provider-staging"], ["production", "synthetic-provider"]]) {
    const commands = adapterWranglerCommands("/tmp/notion-wrangler.jsonc", environmentName, worker);
    assert.deepEqual(commands.deploy, ["deploy", "--config", "/tmp/notion-wrangler.jsonc", "--env", environmentName, "--name", worker]);
    assert.deepEqual(commands.secrets, ["secret", "bulk", "--config", "/tmp/notion-wrangler.jsonc", "--name", worker]);
    assert.equal(commands.secrets.includes("--env"), false);
  }
});

test("canonical release pins dynamic-only encrypted Adapter packaging and provider-specific configuration", () => {
  const manifest = loadProviderManifest();
  assert.match(manifest.revision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.repository, "huangshirui/lifespace-adapters");
  assert.equal(manifest.revision, "6946114d07b0f598e0eea5c0a37094511f5b20dd");
  assert.deepEqual(Object.keys(manifest.providers), ["notion"]);
  assert.equal(manifest.providers.notion.staticConnectionsEnv, undefined);
  assert.ok(readFileSync(new URL("../../.github/workflows/check.yml", import.meta.url), "utf8").includes(`ref: ${manifest.revision}`));
  for (const env of ["staging", "production"]) {
    const workflow = readFileSync(new URL(`../../.github/workflows/${env === "staging" ? "staging" : "production"}-deploy.yml`, import.meta.url), "utf8");
    const prepare = workflow.indexOf(`external-provider-deployment.mjs prepare ${env}`);
    const adapter = workflow.indexOf(`external-provider-deployment.mjs deploy-adapter ${env}`);
    const core = workflow.indexOf(`wrangler deploy --env ${env}`);
    assert.ok(prepare >= 0 && prepare < adapter && adapter < core);
    assert.ok(workflow.indexOf(`external-provider-deployment.mjs sync-core ${env}`) > core);
    assert.ok(workflow.includes("ref: ${{ env.LIFESPACE_EXTERNAL_PROVIDER_REVISION }}"));
    assert.ok(workflow.includes("EXTERNAL_CURSOR_SECRET: ${{ secrets.EXTERNAL_CURSOR_SECRET }}"));
    assert.ok(workflow.includes("LIFESPACE_NOTION_ADAPTER_WORKER: ${{ vars.LIFESPACE_NOTION_ADAPTER_WORKER }}"));
    assert.ok(workflow.includes("NOTION_ADAPTER_SHARED_SECRET: ${{ secrets.NOTION_ADAPTER_SHARED_SECRET }}"));
    assert.ok(workflow.includes("NOTION_CONNECTION_VAULT_MASTER_KEY: ${{ secrets.NOTION_CONNECTION_VAULT_MASTER_KEY }}"));
    assert.equal(workflow.includes("NOTION_CONNECTIONS"), false);
    assert.equal(workflow.includes("LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF"), false);
    if (env === "staging") assert.ok(workflow.includes("NOTION_SMOKE_TOKEN: ${{ secrets.NOTION_SMOKE_TOKEN }}"));
    else assert.equal(workflow.includes("NOTION_SMOKE_TOKEN"), false);
    assert.ok(workflow.includes(`external-provider-deployment.mjs verify ${env}`));
  }
});

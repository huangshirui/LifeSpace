import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVED_STAGING_CIMD_IDS, assessCimdStaging, auditCimdStaging } from "./audit-staging-cimd-egress.mjs";

const publicFlag = ["global_fetch_strictly_public"];
const worker = (flag = "0", options = {}) => ({
  compatibility_flags: options.compatibility_flags ?? publicFlag,
  bindings: [
    { name: "OAUTH_CIMD_ENABLED", type: "plain_text", text: flag },
    ...(options.pins === undefined ? [] : [{ name: "OAUTH_CIMD_ALLOWED_CLIENT_IDS", type: "plain_text", text: options.pins }]),
    ...(options.limits ? ["OAUTH_DCR_RATE_LIMITER", "OAUTH_AUTHORIZE_RATE_LIMITER"].map(name => ({ name, type: "ratelimit" })) : []),
    ...(options.networkBindings ?? []),
  ],
});

test("Wrangler enables only the exact Staging pilot, not Production", () => {
  const config = JSON.parse(readFileSync(new URL("../../apps/identity/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.env.staging.compatibility_flags, publicFlag);
  assert.equal(config.env.staging.vars.OAUTH_CIMD_ENABLED, "1");
  assert.deepEqual(config.env.staging.vars.OAUTH_CIMD_ALLOWED_CLIENT_IDS.split(/\s+/u).sort(),
    [...APPROVED_STAGING_CIMD_IDS].sort());
  assert.equal(config.env.production.vars.OAUTH_CIMD_ALLOWED_CLIENT_IDS, undefined);
  assert.deepEqual(config.env.production.compatibility_flags, publicFlag,
    "Future Production activation must also use public-only fetch; no Production deployment here");
  assert.equal(config.env.production.vars.OAUTH_CIMD_ENABLED, undefined);
  assert.equal(config.env.staging.vpc_networks, undefined);
  assert.equal(config.env.production.vpc_networks, undefined);
});

test("deployed strictly public fetch and disabled switch is safe-closed", () => {
  const r = assessCimdStaging(worker());
  assert.equal(r.safeClosed, true);
  assert.equal(r.status, "SAFE_CLOSED");
  assert.equal(r.strictPublicFetch, true);
});

test("flag absent or disabled must refuse release even when the switch is off", () => {
  for (const flags of [[], ["global_fetch_private_origin"]]) {
    const r = assessCimdStaging(worker("0", { compatibility_flags: flags }));
    assert.equal(r.safeClosed, false);
  }
});

test("an enabled Staging Worker fails closed without exact pins and both limiters", () => {
  assert.equal(assessCimdStaging(worker("1")).safeClosed, false);
  assert.equal(assessCimdStaging(worker("missing")).safeClosed, false);
  assert.equal(assessCimdStaging({ compatibility_flags: publicFlag }).safeClosed, false);
});

test("only the exact bounded pilot passes with both limiters, never a broader list", () => {
  const pins = APPROVED_STAGING_CIMD_IDS.join(" ");
  const pilot = worker("1", { pins, limits: true });
  assert.equal(assessCimdStaging(pilot).status, "SAFE_PINNED_PILOT");
  assert.equal(assessCimdStaging(worker("1", { pins })).safe, false);
  assert.equal(assessCimdStaging(worker("1", { pins: pins + " https://example.org/extra.json", limits: true })).safe, false);
  assert.equal(assessCimdStaging(worker("1", { pins: APPROVED_STAGING_CIMD_IDS[0], limits: true })).safe, false);
  assert.equal(assessCimdStaging(worker("1", { pins, limits: true, compatibility_flags: [...publicFlag, "global_fetch_private_origin"] })).safe, false);
  assert.equal(assessCimdStaging(worker("1", { pins, limits: true,
    networkBindings: [{ name: "PRIVATE_NETWORK", type: "vpc_network" }] })).safe, false);
});

test("any private VPC egress binding fails closed regardless of strict public flag", () => {
  for (const item of [
    { name: "OAUTH_CIMD_EGRESS", type: "vpc_network" },
    { name: "SOME_OTHER_PRIVATE_NETWORK", type: "vpc_network" },
  ]) {
    const r = assessCimdStaging(worker("0", { networkBindings: [item] }));
    assert.equal(r.safeClosed, false);
    assert.equal(r.networkBindings.length, 1);
  }
});

test("audit is read-only and rejects a deployed Worker missing required flag", async () => {
  const options = {
    accountId: "a".repeat(32),
    token: "redacted_test_token",
    getSettings: async () => worker(),
  };
  assert.equal((await auditCimdStaging(options)).safeClosed, true);
  const invalid = await auditCimdStaging({
    ...options,
    getSettings: async () => worker("0", { compatibility_flags: [] }),
  });
  assert.equal(invalid.safeClosed, false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessCimdStaging, auditCimdStaging } from "./audit-staging-cimd-egress.mjs";

const publicFlag = ["global_fetch_strictly_public"];
const worker = (flag = "0", options = {}) => ({
  compatibility_flags: options.compatibility_flags ?? publicFlag,
  bindings: [
    { name: "OAUTH_CIMD_ENABLED", type: "plain_text", text: flag },
    ...(options.networkBindings ?? []),
  ],
});

test("Wrangler requires strictly-public fetch for Identity Staging only", () => {
  const config = JSON.parse(readFileSync(new URL("../../apps/identity/wrangler.jsonc", import.meta.url), "utf8"));
  assert.deepEqual(config.env.staging.compatibility_flags, publicFlag);
  assert.equal(config.env.staging.vars.OAUTH_CIMD_ENABLED, "0");
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

test("a CIMD-enabled Staging Worker is not yet approved without live SSRF network probes", () => {
  assert.equal(assessCimdStaging(worker("1")).safeClosed, false);
  assert.equal(assessCimdStaging(worker("missing")).safeClosed, false);
  assert.equal(assessCimdStaging({ compatibility_flags: publicFlag }).safeClosed, false);
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

test("enabled native deployment requires both limiters and no relay/private bindings", () => {
  const settings = worker("1", {networkBindings:[
    {name:"OAUTH_DCR_RATE_LIMITER",type:"ratelimit"},
    {name:"OAUTH_AUTHORIZE_RATE_LIMITER",type:"ratelimit"},
  ]});
  const expected = {enabled:true};
  assert.equal(assessCimdStaging(settings,expected).status,"NATIVE_CONFIGURED");
  assert.equal(assessCimdStaging(settings).safe,false);
  for (const name of ["OAUTH_DCR_RATE_LIMITER","OAUTH_AUTHORIZE_RATE_LIMITER"]) {
    assert.equal(assessCimdStaging({...settings,bindings:settings.bindings.filter(b=>b.name!==name)},expected).safe,false);
  }
  assert.equal(assessCimdStaging({...settings,compatibility_flags:[...publicFlag,"global_fetch_private_origin"]},expected).safe,false);
  for (const binding of [{name:"PRIVATE",type:"vpc_network"},{name:"PRIVATE_SERVICE",type:"vpc_service"},{name:"OAUTH_CIMD_EGRESS_SECRET",type:"secret_text"}])
    assert.equal(assessCimdStaging({...settings,bindings:[...settings.bindings,binding]},expected).safe,false);
});

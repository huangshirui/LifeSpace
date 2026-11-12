import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {assessCimdStaging,auditCimdStaging} from "./audit-staging-cimd-egress.mjs";
const publicFlag=["global_fetch_strictly_public"];
const limiters=[{name:"OAUTH_DCR_RATE_LIMITER",type:"ratelimit"},{name:"OAUTH_AUTHORIZE_RATE_LIMITER",type:"ratelimit"}];
const worker=(options={})=>({compatibility_flags:options.flags??publicFlag,bindings:options.bindings??limiters});
test("both Identity environments use native public fetch and no feature switches",()=>{
  const config=JSON.parse(readFileSync(new URL("../../apps/identity/wrangler.jsonc",import.meta.url),"utf8"));
  for(const env of [config.env.staging,config.env.production]){
    assert.deepEqual(env.compatibility_flags,publicFlag);
    assert.equal(env.vars.OAUTH_CIMD_ENABLED,undefined);
    assert.equal(env.vars.OAUTH_DCR_ENABLED,undefined);
    assert.equal(env.vpc_networks,undefined);
    assert.equal(env.vpc_services,undefined);
    assert.ok(limiters.every(l=>env.ratelimits.some(r=>r.name===l.name)));
  }
  for(const file of ["staging-deploy.yml","production-deploy.yml"]){
    const workflow=readFileSync(new URL("../../.github/workflows/"+file,import.meta.url),"utf8");
    assert.doesNotMatch(workflow,/LIFESPACE_CIMD_ENABLED|OAUTH_CIMD_ENABLED|OAUTH_DCR_ENABLED/);
    assert.match(workflow,/audit-staging-cimd-egress\.mjs/);
  }
});
test("audit is policy-independent and checks strict-public in both environments",()=>{
  for(const env of ["staging","production"]){
    assert.equal(assessCimdStaging(worker(),env).status,"NATIVE_CONFIGURED");
    for(const flags of [[],["global_fetch_private_origin"],[...publicFlag,"global_fetch_private_origin"]])
      assert.equal(assessCimdStaging(worker({flags}),env).safe,false);
    for(const limiter of limiters)
      assert.equal(assessCimdStaging(worker({bindings:limiters.filter(b=>b!==limiter)}),env).safe,false);
    for(const binding of [
      {name:"PRIVATE",type:"vpc_network"},{name:"PRIVATE_SERVICE",type:"vpc_service"},
      {name:"OAUTH_CIMD_EGRESS_SECRET",type:"secret_text"},
      {name:"OAUTH_CIMD_ENABLED",type:"plain_text",text:"0"},
      {name:"OAUTH_DCR_ENABLED",type:"plain_text",text:"1"}
    ]) assert.equal(assessCimdStaging(worker({bindings:[...limiters,binding]}),env).safe,false);
  }
});
test("read-only audit rejects missing requirements",async()=>{
  const options={accountId:"a".repeat(32),token:"redacted_test_token",getSettings:async()=>worker()};
  assert.equal((await auditCimdStaging(options)).safe,true);
  assert.equal((await auditCimdStaging({...options,environment:"production"})).worker,"lifespace-identity");
  assert.equal((await auditCimdStaging({...options,getSettings:async()=>worker({flags:[]})})).safe,false);
});

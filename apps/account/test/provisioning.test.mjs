import { test } from "node:test";
import assert from "node:assert/strict";
import { requireSingle, strictPolicies, assertAccountAccess } from "../scripts/prepare-staging-access.mjs";
import { requireApplicationPolicy, requireAudience, identifyCredentialRotation, ACCOUNT_APPLICATION_ID, ACCOUNT_APPLICATION_SCOPES } from "../scripts/prepare-staging-identity.mjs";
import { missingBindings, verifyStagingBindings } from "../scripts/verify-staging-bindings.mjs";
import { matchStagingStatus, assertStagingConverged } from "../scripts/check-platform-convergence.mjs";
import { validateRotationState, verifyAndCleanupStagingCredential } from "../scripts/verify-staging-credential-rotation.mjs";

const ACCESS = {
 id:"access-staging",domain:"account-staging.aisr.online",name:"LifeSpace Account Staging",type:"self_hosted",
 aud:"abcd".repeat(16),
};
const POLICY = [{ name:"Only Me",decision:"allow",precedence:1,include:[{email:{email:"owner@example.test"}}] }];
test("Access provisioning allows exactly one distinct Account host and exact owner-email policies", () => {
 assert.equal(requireSingle([ACCESS],ACCESS.domain),ACCESS);
 assert.equal(requireSingle([ACCESS],"account.aisr.online"),null);
 assert.throws(()=>requireSingle([ACCESS,ACCESS],ACCESS.domain),/Duplicate/u);
 assert.equal(strictPolicies(POLICY)[0].name,"Only Me");
 assert.equal(assertAccountAccess(ACCESS,POLICY),ACCESS.aud);
 assert.throws(()=>assertAccountAccess({...ACCESS,domain:"account.aisr.online"},POLICY),/isolated/u);
 for(const bad of [
  [{decision:"allow",include:[{everyone:{}}]}],
  [{decision:"allow",include:[{email_domain:{domain:"example.test"}}]}],
  [{decision:"allow",include:[{email:{email:"owner@example.test"}},{group:{id:"group"}}]}],
  [{decision:"deny",include:[{email:{email:"owner@example.test"}}]}],
 ]) assert.throws(()=>strictPolicies(bad));
});
test("Account Application cannot be silently elevated, renamed, disabled, or regain broad scopes", () => {
 const app = {id:ACCOUNT_APPLICATION_ID,name:"LifeSpace Account staging",
   status:"active",trustedBackend:true,accessTokenTtlSeconds:900,allowedScopes:ACCOUNT_APPLICATION_SCOPES};
 assert.equal(requireApplicationPolicy(app),app);
 for(const changed of [
  {...app,status:"disabled"}, {...app,trustedBackend:false},
  {...app,allowedScopes:[...ACCOUNT_APPLICATION_SCOPES,"platform:admin"]},
  {...app,name:"LifeSpace Console staging"}, {...app,accessTokenTtlSeconds:3600},
 ]) assert.throws(()=>requireApplicationPolicy(changed));
 assert.equal(requireAudience([{audience:ACCESS.aud,status:"active"}],ACCESS.aud)?.audience,ACCESS.aud);
 assert.equal(requireAudience([{audience:ACCESS.aud,status:"revoked"}],ACCESS.aud),null);
 assert.throws(()=>requireAudience([{audience:ACCESS.aud,status:"active"},{audience:ACCESS.aud,status:"active"}],ACCESS.aud));
});
test("Worker binding checks expose only binding names and deny missing secrets", async () => {
 assert.deepEqual(missingBindings(["A","B"],["A","B"]),[]);
 assert.deepEqual(missingBindings(["A"],["A","B"]),["B"]);
 const all={
  "lifespace-account-staging": ["IDENTITY_APPLICATION_CREDENTIAL","ACCOUNT_CSRF_SECRET"],
  "lifespace-core-staging": ["OAUTH_CORE_APPROVER_SECRET"],
  "lifespace-identity-staging": ["OAUTH_CORE_APPROVER_SECRET"],
 };
 const requests=[];
 const res=await verifyStagingBindings({
  env:{CLOUDFLARE_ACCOUNT_ID:"a".repeat(32),CLOUDFLARE_API_TOKEN:"private"},
  fetcher:async url=>{
   requests.push(url);
   const name=Object.keys(all).find(k=>url.includes(k));
   return Response.json({success:true,result:all[name].map(x=>({name:x,type:"secret_text"}))});
  },
 });
 assert.equal(res.ok,true);
 assert.equal(res.accountD1Created,false);
 assert.equal(requests.length,3);
});
test("Staging platform convergence rejects contract/environment downgrade", async()=>{
 const stage={environment:"staging",contractVersion:"1.0",schemaVersion:15};
 assert.equal(matchStagingStatus(stage,{contractVersion:"1.0",schemaVersion:15}),true);
 assert.equal(matchStagingStatus({...stage,environment:"production"},{contractVersion:"1.0",schemaVersion:15}),false);
 assert.equal(matchStagingStatus({...stage,schemaVersion:14},{contractVersion:"1.0",schemaVersion:15}),false);
 // Runtime staging expectation can only be known from actual repo snapshot.
 const {STAGING_EXPECTATIONS}=await import("../../../infra/scripts/staging-expectations.mjs");
 const actual={
  core:{environment:"staging",...STAGING_EXPECTATIONS.core},
  identity:{environment:"staging",...STAGING_EXPECTATIONS.identity},
 };
 const x=await assertStagingConverged(async url=>Response.json({data:url.includes("core-staging")?actual.core:actual.identity}));
 assert.equal(x.ok,true);
 assert.equal(x.noMutations,true);
 await assert.rejects(
  assertStagingConverged(async()=>Response.json({data:actual.core})),
  /identity Staging is not converged/u,
 );
});

test("Account staging rotation identifies the newly issued lsa and all older active credentials", () => {
  const issued = "lsa_" + "x".repeat(36);
  const rows = [
    { id: "apc_current", secretSuffix: issued.slice(-8), status: "active", revokedAt: null },
    { id: "apc_older", secretSuffix: "other123", status: "active", revokedAt: null },
    { id: "apc_revoked", secretSuffix: "unused123", status: "revoked", revokedAt: "2026-10-01" },
  ];
  assert.deepEqual(identifyCredentialRotation(rows, issued), {
    currentId: "apc_current", oldIds: ["apc_older"],
  });
  assert.throws(() => identifyCredentialRotation(
    [...rows, { id: "apc_collision", secretSuffix: issued.slice(-8), status: "active", revokedAt: null }], issued,
  ), /uniquely identify/u);
  assert.deepEqual(validateRotationState(rows, "apc_current", ["apc_older"]), ["apc_older"]);
  assert.throws(() => validateRotationState(rows, "apc_current", []), /outside this staging release/u);
});

test("new Account credential must pass Identity self-inspection before old keys are revoked", async () => {
  const active = new Set(["apc_new", "apc_old"]);
  const issued = "lsa_" + "z".repeat(36);
  const events = [];
  let valid = false;
  const mock = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    events.push({ path, method });
    if (path === "/internal/v1/applications/self") {
      assert.equal(init.headers.authorization, "Bearer " + issued);
      return Response.json({ data: {
        id: valid ? ACCOUNT_APPLICATION_ID : "app_wrong",
        status: "active",
      } });
    }
    if (path.endsWith("/credentials") && method === "GET") {
      return Response.json({ data: [...active].map(id => ({
        id, status: "active", revokedAt: null, secretSuffix: id === "apc_new" ? issued.slice(-8) : "older999",
      })) });
    }
    if (path.endsWith("/credentials/apc_old") && method === "DELETE") {
      active.delete("apc_old");
      return new Response(null, { status: 204 });
    }
    throw new Error("Unexpected credential lifecycle request " + method + " " + path);
  };
  const env = {
    LIFESPACE_STAGING_BOOTSTRAP_SECRET: "s".repeat(40),
    LIFESPACE_STAGING_ACCOUNT_APPLICATION_CREDENTIAL: issued,
    LIFESPACE_STAGING_ACCOUNT_CURRENT_CREDENTIAL_ID: "apc_new",
    LIFESPACE_STAGING_ACCOUNT_OLD_CREDENTIAL_IDS: "apc_old",
  };
  await assert.rejects(verifyAndCleanupStagingCredential({ env, fetcher: mock }), /old keys are preserved/u);
  assert.equal(active.has("apc_old"), true);
  assert.equal(events.some(e => e.method === "DELETE"), false);
  valid = true;
  const result = await verifyAndCleanupStagingCredential({ env, fetcher: mock });
  assert.deepEqual(result, {
    ok: true, applicationId: ACCOUNT_APPLICATION_ID, verifiedCurrentCredential: true,
    revokedCredentialCount: 1, remainingActiveCredentials: 1, plaintextLogged: false,
  });
  assert.deepEqual([...active], ["apc_new"]);
  assert.equal(events.filter(e => e.method === "DELETE").length, 1);
});

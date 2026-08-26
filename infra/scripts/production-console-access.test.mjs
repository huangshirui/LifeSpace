import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_ACCESS_DOMAIN,
  applicationDomains,
  assertExistingProductionAccess,
  buildProductionAccessApplication,
  cloneStrictAllowPolicy,
  matchingApplications,
} from "./prepare-production-console-access.mjs";

const ownerPolicy = {
  name: "Only owner",
  decision: "allow",
  precedence: 5,
  include: [{ email: { email: "owner@example.com" } }],
  exclude: [],
  require: [],
};

test("matches Access applications by primary or self-hosted domain", () => {
  const applications = [
    { domain: "one.example.com" },
    { self_hosted_domains: ["two.example.com", "three.example.com"] },
  ];
  assert.deepEqual(applicationDomains(applications[1]), ["two.example.com", "three.example.com"]);
  assert.equal(matchingApplications(applications, "three.example.com").length, 1);
});

test("clones only explicit-email allow policies and strips identifiers", () => {
  const cloned = cloneStrictAllowPolicy({
    ...ownerPolicy,
    id: "policy-id",
    account_id: "account-id",
    session_duration: "24h",
  });
  assert.equal(cloned.decision, "allow");
  assert.equal(cloned.precedence, 1);
  assert.equal(cloned.id, undefined);
  assert.equal(cloned.account_id, undefined);
  assert.equal(cloned.include[0].email.email, "owner@example.com");
  assert.equal(cloned.session_duration, "24h");
});

test("rejects broad, service-auth and non-owner staging policies", () => {
  assert.throws(() => cloneStrictAllowPolicy({ ...ownerPolicy, decision: "bypass" }), /only accepts allow/u);
  assert.throws(() => cloneStrictAllowPolicy({ ...ownerPolicy, include: [{ everyone: {} }] }), /broad\/non-human/u);
  assert.throws(() => cloneStrictAllowPolicy({ ...ownerPolicy, include: [{ service_token: { token_id: "x" } }] }), /broad\/non-human/u);
  assert.throws(() => cloneStrictAllowPolicy({ ...ownerPolicy, include: [{ email_domain: { domain: "example.com" } }] }), /explicit email/u);
});

test("builds production self-hosted Access application from accepted staging shape", () => {
  const body = buildProductionAccessApplication({
    type: "self_hosted",
    domain: "lifespace-staging.aisr.online",
    session_duration: "24h",
    allowed_idps: ["idp-1"],
    auto_redirect_to_identity: true,
    app_launcher_visible: false,
  }, [ownerPolicy]);
  assert.equal(body.domain, PRODUCTION_ACCESS_DOMAIN);
  assert.equal(body.type, "self_hosted");
  assert.deepEqual(body.allowed_idps, ["idp-1"]);
  assert.equal(body.auto_redirect_to_identity, true);
  assert.equal(body.app_launcher_visible, false);
  assert.equal(body.policies.length, 1);
});

test("validates an existing production Access application before reuse", () => {
  const audience = assertExistingProductionAccess({
    id: "app-id",
    type: "self_hosted",
    domain: PRODUCTION_ACCESS_DOMAIN,
    aud: "audience-tag",
  }, [ownerPolicy]);
  assert.equal(audience, "audience-tag");
  assert.throws(() => assertExistingProductionAccess({
    type: "self_hosted",
    domain: PRODUCTION_ACCESS_DOMAIN,
    aud: "audience-tag",
  }, [{ ...ownerPolicy, include: [{ everyone: {} }] }]), /broad\/non-human/u);
});

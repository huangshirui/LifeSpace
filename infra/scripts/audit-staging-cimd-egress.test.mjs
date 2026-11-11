import test from "node:test";
import assert from "node:assert/strict";
import { assessCimdStaging, auditCimdStaging } from "./audit-staging-cimd-egress.mjs";

const flag = value => ({ name: "OAUTH_CIMD_ENABLED", type: "plain_text", text: value });
const egress = { name: "OAUTH_CIMD_EGRESS", type: "vpc_network" };
const allowAllPrivateRule = {
  enabled: true,
  action: "block",
  filters: ["l4"],
  traffic: "net.dst.ip in {10.0.0.0/8 127.0.0.0/8 192.168.0.0/16 fc00::/7}",
};

test("CIMD is safely closed only with disabled release switch and no egress binding", () => {
  const result = assessCimdStaging({ bindings: [flag("0")] });
  assert.equal(result.safeClosed, true);
  assert.equal(result.code, "SAFE_CLOSED");
  assert.equal(result.deploymentFlag, "0");
});

test("an enabled CIMD switch is not accepted even if no egress binding exists", () => {
  const result = assessCimdStaging({ bindings: [flag("1")] });
  assert.equal(result.safeClosed, false);
  assert.equal(result.code, "CIMD_DEPLOYMENT_FLAG_NOT_CLOSED");
});

test("an egress binding is unapproved regardless of release flag or Gateway rules", () => {
  for (const value of ["0", "1"]) {
    const result = assessCimdStaging({
      bindings: [flag(value), egress], gatewayRules: [allowAllPrivateRule],
    });
    assert.equal(result.safeClosed, false);
    assert.equal(result.code, "EGRESS_ATTACHED_WITHOUT_NETWORK_SECURITY_ATTESTATION");
    assert.equal(result.gatewayNetworkDenyCount, 1);
    // Enabled blocking rules are not proof of DNS-rebinding safety.
  }
});

test("a disabled Gateway private-network rule does not count as enforcement", () => {
  const result = assessCimdStaging({
    bindings: [flag("0")], gatewayRules: [{ ...allowAllPrivateRule, enabled: false }],
  });
  assert.equal(result.safeClosed, true);
  assert.equal(result.gatewayNetworkDenyCount, 0);
  assert.equal(result.gatewayDisabledNetworkDenyCount, 1);
});

test("read-only Cloudflare audit tolerates missing Gateway listing only when safely closed", async () => {
  const opts = {
    accountId: "a".repeat(32), token: "fake-test-token",
    fetchSettings: async () => ({ bindings: [flag("0")] }),
    fetchGatewayRules: async () => { throw Error("token detail must not leak"); },
  };
  const result = await auditCimdStaging(opts);
  assert.equal(result.safeClosed, true);
  assert.match(result.gatewayReadError, /not readable/u);
  assert.doesNotMatch(JSON.stringify(result), /token detail/u);
  const unsafe = await auditCimdStaging({
    ...opts, fetchSettings: async () => ({ bindings: [flag("1"), egress] }),
  });
  assert.equal(unsafe.safeClosed, false);
});

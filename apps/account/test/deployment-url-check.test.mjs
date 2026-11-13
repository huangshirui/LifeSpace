import assert from "node:assert/strict";
import test from "node:test";
import { hasExactProvisionedUrl } from "../scripts/deployment-url-check.mjs";

const issuer = "https://auth-staging.aisr.online";
const consent = "https://account-staging.aisr.online/oauth/consent";
const pair = (url, setting, environment = "staging") =>
  "  printf '%s' '" + url + "' |\n    pnpm --dir apps/identity exec wrangler secret put " + setting + " --env " + environment + " >/dev/null";

test("Account provisioning checks exact literal and destination command", () => {
  const workflow = pair(issuer, "OAUTH_ISSUER") + "\n" + pair(consent, "OAUTH_CONSENT_URL");
  assert.equal(hasExactProvisionedUrl(workflow, "OAUTH_ISSUER", issuer), true);
  assert.equal(hasExactProvisionedUrl(workflow, "OAUTH_CONSENT_URL", consent), true);
  for (const wrong of [issuer + ".evil.example", issuer + "@evil.example", "https://evil.example/?" + issuer, issuer + "/other"]) {
    assert.equal(hasExactProvisionedUrl(pair(wrong, "OAUTH_ISSUER"), "OAUTH_ISSUER", issuer), false);
  }
  assert.equal(hasExactProvisionedUrl(pair(consent + "/evil", "OAUTH_CONSENT_URL"), "OAUTH_CONSENT_URL", consent), false);
  assert.equal(hasExactProvisionedUrl(pair(issuer, "OAUTH_ISSUER", "production"), "OAUTH_ISSUER", issuer), false);
  assert.equal(hasExactProvisionedUrl(pair(issuer, "OAUTH_CONSENT_URL"), "OAUTH_ISSUER", issuer), false);
  assert.equal(hasExactProvisionedUrl("# " + pair(issuer, "OAUTH_ISSUER"), "OAUTH_ISSUER", issuer), false);
});

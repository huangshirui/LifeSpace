// Check the actual literal piped to the reviewed Staging Identity secret
// command, not an arbitrary URL substring elsewhere in the workflow.
export function hasExactProvisionedUrl(workflow, setting, expectedUrl) {
  if (setting !== "OAUTH_ISSUER" && setting !== "OAUTH_CONSENT_URL") return false;
  const lines = workflow.split(/\r?\n/u).map(line => line.trim());
  const literal = "printf '%s' '" + expectedUrl + "' |";
  const command = "pnpm --dir apps/identity exec wrangler secret put " + setting + " --env staging >/dev/null";
  return lines.some((line, index) => line === literal && lines[index + 1] === command);
}

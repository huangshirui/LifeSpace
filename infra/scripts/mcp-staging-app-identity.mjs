// Read-only self-inspection of a trusted lsa_* is the authority for application identity.
// An independently entered GitHub Application ID is an optional, stricter cross-check.
export function verifyMcpStagingApplication(application, configuredApplicationId = "") {
  const id = typeof application?.id === "string" ? application.id : "";
  if (!/^app_[a-zA-Z0-9_-]+$/u.test(id)) throw new Error("Identity returned an invalid Application ID");
  if (configuredApplicationId && !/^app_[a-zA-Z0-9_-]+$/u.test(configuredApplicationId)) {
    throw new Error("Configured MCP Application ID is malformed");
  }
  if (configuredApplicationId && configuredApplicationId !== id) {
    throw new Error("Configured MCP Application ID does not match the authenticated credential");
  }
  if (application.name !== "LifeSpace MCP Staging" || application.status !== "active"
    || application.trustedBackend !== true
    || !Number.isInteger(application.accessTokenTtlSeconds)
    || application.accessTokenTtlSeconds < 300
    || application.accessTokenTtlSeconds > 900
    || !Array.isArray(application.allowedScopes)
    || application.allowedScopes.length !== 1
    || application.allowedScopes[0] !== "resources:read") {
    throw new Error("MCP Application must be active, trusted, bounded to resources:read and short-lived");
  }
  return { idSource: configuredApplicationId ? "configured_and_self_verified" : "identity_self_verified" };
}

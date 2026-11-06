export type UserPrincipal = {
  id: string;
  clientId: string;
  scopes: string[];
  tokenId: string;
};

export type Bindings = {
  DB: D1Database;
  ASSETS: R2Bucket;
  TOKEN_PRIVATE_KEY: string;
  TOKEN_PUBLIC_KEY: string;
  BOOTSTRAP_SECRET: string;
  CORE_IDENTITY_SHARED_SECRET: string;
  ACCESS_TEAM_DOMAIN?: string;
  ENVIRONMENT?: string;
  PERFORMANCE_DIAGNOSTICS?: string;
  // Interactive OAuth AS settings. All sensitive values are injected at deploy time.
  OAUTH_ISSUER?: string;
  OAUTH_CONSENT_URL?: string;
  OAUTH_ACCOUNT_APPLICATION_ID?: string;
  OAUTH_ALLOWED_RESOURCES?: string;
  // Canonical Core origin for dynamically configured MCP Server resources.
  OAUTH_MCP_RESOURCE_ORIGIN?: string;
  // Private same-environment Core service, never a public fetch.
  CORE?: Fetcher;
  OAUTH_RESOURCE_SERVER_SECRET?: string;
  OAUTH_CORE_APPROVER_SECRET?: string;
  OAUTH_DCR_ENABLED?: string;
  // Opt-in HTTPS Client ID Metadata Documents; disabled unless explicitly enabled.
  OAUTH_CIMD_ENABLED?: string;
};

export type RequestPerformanceTiming = {
  startedAt: number;
  phases: Record<string, number>;
};

export type Variables = {
  requestId: string;
  currentApplicationId: string;
  currentApplicationScopes: string[];
  currentApplicationTokenTtlSeconds: number;
  principal: UserPrincipal;
  performanceTiming?: RequestPerformanceTiming;
};

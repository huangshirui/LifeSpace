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

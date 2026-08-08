export type Bindings = {
  DB: D1Database;
  TOKEN_PRIVATE_KEY: string;
  BOOTSTRAP_SECRET: string;
  ENVIRONMENT?: string;
};

export type Variables = {
  requestId: string;
  currentApplicationId: string;
  currentApplicationScopes: string[];
  currentApplicationTokenTtlSeconds: number;
};

export type PrincipalType = "user" | "service" | "device";

export type Principal = {
  type: PrincipalType;
  id: string;
  clientId: string;
  scopes: string[];
  tokenId: string;
};

export type Bindings = CloudflareBindings & {
  IDENTITY_PUBLIC_KEY: string;
  IDENTITY?: Fetcher;
  CORE_IDENTITY_SHARED_SECRET?: string;
  ASSETS: R2Bucket;
  CORS_ORIGINS?: string;
  CREATION_DRAFT_QUEUE: Queue;
  EVENT_DELIVERY_QUEUE: Queue;
  AI_RATE_LIMITER: RateLimit;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  AI_PROMPT_APPENDIX?: string;
};

export type Variables = {
  requestId: string;
  principal: Principal;
};

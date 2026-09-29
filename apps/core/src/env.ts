export const PRINCIPAL_TYPES = ["user", "service", "device"] as const;
export type PrincipalType = typeof PRINCIPAL_TYPES[number];

export const ACTOR_TYPES = [...PRINCIPAL_TYPES, "agent"] as const;
export type ActorType = typeof ACTOR_TYPES[number];

export function isPrincipalType(value: unknown): value is PrincipalType {
  return typeof value === "string" && (PRINCIPAL_TYPES as readonly string[]).includes(value);
}

export function isActorType(value: unknown): value is ActorType {
  return typeof value === "string" && (ACTOR_TYPES as readonly string[]).includes(value);
}

export type Actor = {
  type: ActorType;
  id: string;
};

export type Principal = {
  type: PrincipalType;
  id: string;
  displayName?: string;
  clientId: string;
  scopes: string[];
  tokenId: string;
  actor?: Actor;
  purpose?: "delegated_agent";
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
  PERFORMANCE_DIAGNOSTICS?: string;
};

export type RequestPerformanceTiming = {
  startedAt: number;
  phases: Record<string, number>;
};

export type Variables = {
  requestId: string;
  principal: Principal;
  performanceTiming?: RequestPerformanceTiming;
};

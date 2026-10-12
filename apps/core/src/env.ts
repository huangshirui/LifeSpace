import {
  canBeActor,
  canBePrincipal,
  ENTITY_ROLE_CAPABILITIES,
  type EntityType,
} from "./entity-role-capability";

export const PRINCIPAL_TYPES = Object.keys(ENTITY_ROLE_CAPABILITIES) as EntityType[];
export type PrincipalType = EntityType;

export const ACTOR_TYPES = Object.keys(ENTITY_ROLE_CAPABILITIES) as EntityType[];
export type ActorType = EntityType;

export function isPrincipalType(value: unknown): value is PrincipalType {
  return canBePrincipal(value);
}

export function isActorType(value: unknown): value is ActorType {
  return canBeActor(value);
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
  purpose?: "agent_execution" | "agent_api";
};

export type Bindings = CloudflareBindings & {
  IDENTITY_PUBLIC_KEY: string;
  RECURRENCE_WINDOW_DAYS?: string;
  IDENTITY?: Fetcher;
  CORE_IDENTITY_SHARED_SECRET?: string;
  ASSETS: R2Bucket;
  CORS_ORIGINS?: string;
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

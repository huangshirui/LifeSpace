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
  purpose?: "agent_execution" | "agent_api" | "oauth_agent_execution";
  // Verified signed Identity OAuth execution attributes. Never caller assertions.
  oauthExecution?: {
    authorizationId: string;
    accessHash: string;
    resource: string;
    clientId: string;
    spaceId: string;
    applicationId: string;
    agentId: string;
    // Core-derived per-request MCP Server policy, never an Identity JWT claim.
    serverId?: string;
    queryModelKeys?: string[];
  };
};

export type Bindings = CloudflareBindings & {
  EXTERNAL_PROVIDER_ROUTES?: string;
  EXTERNAL_CURSOR_SECRET?: string;
  // Compatibility only for local/historical generic Adapter tests. Canonical
  // staging/production uses EXTERNAL_PROVIDER_ROUTES plus provider-specific
  // Service Bindings/secrets; cursor signing uses EXTERNAL_CURSOR_SECRET.
  EXTERNAL_ADAPTER?: Fetcher;
  EXTERNAL_ADAPTER_SHARED_SECRET?: string;
  EXTERNAL_SCHEMA_REFRESH_SECONDS?: string;
  IDENTITY_PUBLIC_KEY: string;
  RECURRENCE_WINDOW_DAYS?: string;
  IDENTITY?: Fetcher;
  // Private transport binding, populated only after reviewed MCP staging setup.
  MCP_ADAPTER?: Fetcher;
  // Explicit opt-in for local/integration tests; public origins are fixed by ENVIRONMENT.
  MCP_PUBLIC_ORIGIN?: string;
  CORE_IDENTITY_SHARED_SECRET?: string;
  OAUTH_ACCOUNT_APPLICATION_ID?: string;
  OAUTH_CORE_APPROVER_SECRET?: string;
  ASSETS: R2Bucket;
  R2_S3_ACCOUNT_ID?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_S3_BUCKET?: string;
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

export type EnvironmentName = "local" | "staging" | "production" | string;

export type ConsoleSession = {
  environment: EnvironmentName;
  consoleVersion: string;
  identityAdminApiVersion: string;
  coreAdminApiVersion: string;
  user: {
    id: string;
    displayName: string;
    status: "active" | "disabled" | string;
  };
};

export type ServiceStatus = {
  environment?: string;
  schemaVersion?: number | string;
  contractVersion?: string;
  registryRevision?: string;
  [key: string]: unknown;
};

export type OverviewData = {
  generatedAt: string;
  environment: EnvironmentName;
  counts: {
    applications: number;
    models: number;
    users: number;
    usersTruncated: boolean;
    spaces: number;
    spacesTruncated: boolean;
  };
  identityStatus: ServiceStatus;
  coreStatus: ServiceStatus;
  recentAudit: AuditEntry[];
};

export type Application = {
  id: string;
  name: string;
  allowedScopes: string[];
  trustedBackend: boolean;
  accessTokenTtlSeconds: number;
  status: "active" | "disabled" | string;
  createdAt: string;
  updatedAt: string;
};

export type ApplicationCredential = {
  id: string;
  applicationId: string;
  secretSuffix: string;
  status: string;
  createdAt: string;
  revokedAt: string | null;
};

export type AccessAudience = {
  id: string;
  applicationId: string;
  issuer: string;
  audience: string;
  status: string;
  createdAt: string;
  revokedAt: string | null;
};

export type ServicePrincipal = {
  id: string;
  applicationId: string;
  displayName: string;
  description: string | null;
  maxScopes: string[];
  status: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt: string | null;
};

export type ModelAccess = {
  applicationId: string;
  modelKey: string;
  maxAccess: "read" | "write" | "manage";
  createdBy: { type: string; id: string };
  createdAt: string;
  updatedAt: string;
};

export type ApplicationDetail = {
  application: Application;
  credentials: ApplicationCredential[];
  accessAudiences: AccessAudience[];
  servicePrincipals: ServicePrincipal[];
  modelAccess: ModelAccess[];
};

export type PublishedModel = {
  id: string;
  key: string;
  version: number;
  state: string;
  schemaHash: string;
  compatibility: string;
  definition: Record<string, unknown>;
  publishedAt: string | null;
};

export type PlatformUser = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type AccessPrincipalDiagnostic = {
  id: string;
  issuer: string;
  subject: string;
  userId: string;
  emailSnapshot: string | null;
  status: string;
  linkedAt: string;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlatformUserDetail = PlatformUser & {
  accessPrincipals: AccessPrincipalDiagnostic[];
};

export type PlatformSpace = {
  id: string;
  name: string;
  timezone: string;
  avatarUrl: string | null;
  version: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  grantCount: number;
  recordCount: number;
};

export type PlatformSpaceDetail = PlatformSpace & {
  members: Array<{
    id: string;
    userId: string;
    personId: string;
    displayName: string;
    role: string;
    version: number;
    createdAt: string;
  }>;
  grants: Array<{
    id: string;
    granteeType: string;
    granteeId: string;
    resourceType: string;
    resourceId: string | null;
    permission: string;
    createdByUserId: string;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
  }>;
  recordCounts: Record<string, number>;
};

export type AuditEntry = {
  source: "identity" | "core";
  id: string;
  actorUserId: string;
  actorApplicationId: string;
  executorApplicationId: string;
  executorPrincipalId?: string;
  operation: string;
  targetType: string;
  targetId: string;
  summary: Record<string, unknown>;
  requestId: string;
  result: "pending" | "success" | "failure" | string;
  createdAt: string;
};

export type AuditData = {
  identity: AuditEntry[];
  core: AuditEntry[];
};

export type SystemData = {
  environment: EnvironmentName;
  consoleVersion: string;
  identityAdminApiVersion: string;
  coreAdminApiVersion: string;
  identityStatus: ServiceStatus;
  coreStatus: ServiceStatus;
  securityBoundary: {
    accessAssertion: "server-only";
    lifespaceUserBearer: "server-only";
    actorProof: "server-only";
    identityExecutor: "server-only";
    coreExecutor: "server-only";
    bootstrapAuthority: "not-runtime";
  };
};

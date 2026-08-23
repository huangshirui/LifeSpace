import type {
  Application,
  ApplicationDetail,
  AuditData,
  ConsoleSession,
  OverviewData,
  PlatformSpace,
  PlatformSpaceDetail,
  PlatformUser,
  PlatformUserDetail,
  PublishedModel,
  SystemData,
} from "./types";

type Envelope<T> = { data: T };
type ErrorEnvelope = { error?: { code?: string; message?: string; requestId?: string } };

export class ConsoleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ConsoleApiError";
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null) as Envelope<T> | ErrorEnvelope | null;
  if (!response.ok) {
    const error = payload && "error" in payload ? payload.error : undefined;
    throw new ConsoleApiError(
      error?.message ?? `Request failed with HTTP ${response.status}`,
      response.status,
      error?.code,
      error?.requestId,
    );
  }
  if (!payload || !("data" in payload)) throw new ConsoleApiError("BFF response did not contain data", 502, "INVALID_BFF_RESPONSE");
  return payload.data;
}

export const consoleApi = {
  session: () => request<ConsoleSession>("/api/session"),
  overview: () => request<OverviewData>("/api/overview"),
  applications: () => request<Application[]>("/api/applications"),
  application: (applicationId: string) => request<ApplicationDetail>(`/api/applications/${encodeURIComponent(applicationId)}`),
  models: () => request<PublishedModel[]>("/api/models"),
  model: (modelKey: string) => request<PublishedModel>(`/api/models/${encodeURIComponent(modelKey)}`),
  users: (query = "") => request<PlatformUser[]>(`/api/users${query}`),
  user: (userId: string) => request<PlatformUserDetail>(`/api/users/${encodeURIComponent(userId)}`),
  spaces: (query = "") => request<PlatformSpace[]>(`/api/spaces${query}`),
  space: (spaceId: string) => request<PlatformSpaceDetail>(`/api/spaces/${encodeURIComponent(spaceId)}`),
  audit: (limit = 100) => request<AuditData>(`/api/audit?limit=${limit}`),
  system: () => request<SystemData>("/api/system"),
};

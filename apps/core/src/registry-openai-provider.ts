export type ProviderErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_TIMEOUT"
  | "AI_RATE_LIMITED"
  | "AI_REQUEST_REJECTED"
  | "AI_AUTHENTICATION_FAILED"
  | "AI_QUOTA_EXCEEDED"
  | "AI_ACCESS_DENIED"
  | "AI_MODEL_NOT_FOUND"
  | "AI_UPSTREAM_UNAVAILABLE"
  | "AI_INVALID_RESPONSE";

export class OpenAICompatibleProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "OpenAICompatibleProviderError";
  }
}

export type AiProviderResult = {
  output: unknown;
  metadata: {
    providerStatus: number;
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  };
};

export type OpenAICompatibleProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  promptAppendix?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  appTitle?: string;
  appReferer?: string;
  requireParameters?: boolean;
};

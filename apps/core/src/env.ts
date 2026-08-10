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
  CORS_ORIGINS?: string;
};

export type Variables = {
  requestId: string;
  principal: Principal;
};

import type { Bindings } from "../../src/env";

export const CORE_IDENTITY_TEST_SECRET = "core-identity-test-secret-at-least-32-chars";

function activeServicePrincipalBinding(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      if (request.headers.get("x-lifespace-internal-secret") !== CORE_IDENTITY_TEST_SECRET) {
        return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
      }
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname.startsWith("/introspection/v1/service-principals/")) {
        return Response.json({ data: { active: true, displayName: "Test service principal" } });
      }
      return new Response("not found", { status: 404 });
    },
    connect() { throw new Error("not implemented"); },
  } as unknown as Fetcher;
}

export function activeServicePrincipalIdentityBindings(): Pick<Bindings, "IDENTITY" | "CORE_IDENTITY_SHARED_SECRET"> {
  return {
    IDENTITY: activeServicePrincipalBinding(),
    CORE_IDENTITY_SHARED_SECRET: CORE_IDENTITY_TEST_SECRET,
  };
}

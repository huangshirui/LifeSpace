import externalConnectionsWorker from "./external-connections";
import platformOverviewWorker from "./platform-overview";

interface Env {
  ENVIRONMENT: string;
  IDENTITY_BASE_URL: string;
  CORE_BASE_URL: string;
  IDENTITY_APPLICATION_CREDENTIAL?: string;
  CORE_EXECUTOR_BEARER?: string;
  IDENTITY?: Fetcher;
  CORE?: Fetcher;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/overview" && !url.search) {
      return platformOverviewWorker.fetch(request, env);
    }
    return externalConnectionsWorker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

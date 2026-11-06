import { describe, expect, it } from "vitest";
import {
  cimdClientId, fetchClientMetadata, parseClientMetadata, publicRedirectUri,
} from "../src/oauth-client-metadata";

const clientId = "https://client.example.com/oauth/client.json";
const metadata = {
  client_id: clientId, client_name: "Synthetic MCP Client",
  redirect_uris: ["https://client.example.com/callback", "http://127.0.0.1:9000/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"], token_endpoint_auth_method: "none",
};

describe("CIMD public client metadata is untrusted until verified", () => {
  it("requires a public HTTPS metadata URL with a path, not internal network targets", () => {
    expect(cimdClientId(clientId)).toBe(true);
    for (const candidate of [
      "https://localhost/client.json", "https://127.0.0.1/client.json",
      "https://[::1]/client.json", "http://client.example.com/oauth/client.json",
      "https://client.example.com", "https://client.local/client.json",
      "https://svc.internal/client.json", "https://client.example.test/oauth/client.json",
      "https://admin:password@client.example.com/metadata.json",
      clientId + "?redirect=https://evil.com", clientId + "#secret",
    ]) expect(cimdClientId(candidate)).toBe(false);
  });

  it("binds the exact metadata-document client_id to explicit callback URIs", () => {
    expect(parseClientMetadata(clientId, metadata)).toEqual({
      clientId, displayName: "Synthetic MCP Client", redirectUris: metadata.redirect_uris,
    });
    for (const bad of [
      { ...metadata, client_id: "https://evil.example.com/client.json" },
      { ...metadata, redirect_uris: ["https://*.example.com/callback"] },
      { ...metadata, redirect_uris: ["http://evil.example.com/callback"] },
      { ...metadata, redirect_uris: ["http://localhost.local/callback"] },
      { ...metadata, redirect_uris: [metadata.redirect_uris[0], metadata.redirect_uris[0]] },
      { ...metadata, token_endpoint_auth_method: "client_secret_basic" },
      { ...metadata, client_name: "" },
    ]) expect(parseClientMetadata(clientId, bad)).toBeNull();
    expect(publicRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(publicRedirectUri("http://127.0.0.1:3000/callback")).toBe(true);
    expect(publicRedirectUri("https://client.example.com/callback")).toBe(true);
  });

  it("never follows redirects, limits bytes and requires JSON media type", async () => {
    const calls: Array<{ url: string; redirect?: string }> = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, redirect: init.redirect });
      return new Response(JSON.stringify(metadata), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const read = await fetchClientMetadata(clientId, fake as typeof fetch);
    expect(read?.clientId).toBe(clientId);
    expect(calls).toEqual([{ url: clientId, redirect: "manual" }]);
    expect(await fetchClientMetadata(clientId, (async () => new Response(null, {
      status: 302, headers: { location: "https://evil.example.com/redirect" },
    })) as typeof fetch)).toBeNull();
    expect(await fetchClientMetadata(clientId, (async () => new Response("A".repeat(9000), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch)).toBeNull();
    expect(await fetchClientMetadata(clientId, (async () => new Response(JSON.stringify(metadata), {
      headers: { "content-type": "text/html" },
    })) as typeof fetch)).toBeNull();
  });
});

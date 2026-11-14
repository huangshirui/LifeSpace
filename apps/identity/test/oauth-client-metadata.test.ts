import { describe, expect, it } from "vitest";
import {
  cimdClientId, approvedCimdClientId, fetchClientMetadata, fetchClientMetadataResult, cimdFreshUntil, parseClientMetadata, publicRedirectUri, ordinaryPublicIp, precheckCimdDns,
} from "../src/oauth-client-metadata";

const clientId = "https://client.example.com/oauth/client.json";
const metadata = {
  client_id: clientId, client_name: "Synthetic MCP Client",
  redirect_uris: ["https://client.example.com/callback", "http://127.0.0.1:9000/oauth/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"], token_endpoint_auth_method: "none",
};

const dnsAnswer = (url: string, ip = "8.8.8.8") => Response.json({
  Status: 0, Answer: url.endsWith("type=1") ? [{type:1,data:ip}] : [],
});
const withDns = (response: Response) => (async (url: string) =>
  url.startsWith("https://cloudflare-dns.com/dns-query?") ? dnsAnswer(url) : response) as typeof fetch;

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

  it("rejects every unpinned CIMD client, including host lookalikes", () => {
    expect(approvedCimdClientId(clientId, "")).toBe(false);
    expect(approvedCimdClientId(clientId, undefined)).toBe(false);
    expect(approvedCimdClientId(clientId, "https://client.example.com/other.json")).toBe(false);
    expect(approvedCimdClientId(clientId, "https://*.example.com/oauth/client.json")).toBe(false);
    expect(approvedCimdClientId(clientId, clientId + " " + clientId)).toBe(false);
    expect(approvedCimdClientId(clientId, clientId)).toBe(true);
    expect(approvedCimdClientId(clientId,
      "https://other.example.com/oauth/client.json\n" + clientId)).toBe(true);
    expect(approvedCimdClientId(clientId + "?foo=bar", clientId)).toBe(false);
    expect(approvedCimdClientId(clientId, clientId + " http://localhost/bad")).toBe(false);
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
    // ChatGPT 2026 CIMD advertises both public "none" and private_key_jwt.
    expect(parseClientMetadata(clientId, {
      ...metadata,
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    })).not.toBeNull();
    expect(parseClientMetadata(clientId, {
      ...metadata,
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    })).toBeNull();
    expect(parseClientMetadata(clientId, {
      ...metadata,
      token_endpoint_auth_methods_supported: "none",
    })).toBeNull();
    expect(publicRedirectUri("http://localhost:3000/callback")).toBe(true);
    expect(publicRedirectUri("http://127.0.0.1:3000/callback")).toBe(true);
    expect(publicRedirectUri("https://client.example.com/callback")).toBe(true);
  });

  it("accepts compatible multi-grant metadata without granting new authority", () => {
    const chatgptId = "https://chatgpt.com/oauth/client.json";
    const chatgpt = {
      client_id: chatgptId, client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
      response_types: ["code"],
      jwks_uri: "https://chatgpt.com/oauth/jwks.json",
    };
    expect(parseClientMetadata(chatgptId, chatgpt)).toEqual({
      clientId: chatgptId, displayName: "ChatGPT", redirectUris: chatgpt.redirect_uris,
    });
    expect(parseClientMetadata(clientId, {
      ...metadata, grant_types: ["authorization_code", "urn:example:future-grant"],
    })).toEqual({
      clientId, displayName: metadata.client_name, redirectUris: metadata.redirect_uris,
    });
    for (const grant_types of [
      ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
      ["authorization_code", 123],
      ["authorization_code", "bad grant"],
      ["authorization_code", "authorization_code"],
      ["authorization_code", ""],
    ]) expect(parseClientMetadata(clientId, { ...metadata, grant_types })).toBeNull();
  });

  it("blocks special-use addresses including globally routable special ranges", async () => {
    for (const ip of ["127.0.0.1","10.1.2.3","169.254.1.1","100.64.0.1","192.0.0.9","192.31.196.1","224.1.2.3","256.1.1.1"])
      expect(ordinaryPublicIp(ip,4)).toBe(false);
    for (const ip of ["::1","::ffff:8.8.8.8","fd00::1","fe80::1","2001:db8::1","2001:1::1","2620:4f:8000::1","3fff::1"])
      expect(ordinaryPublicIp(ip,6)).toBe(false);
    expect(ordinaryPublicIp("8.8.8.8",4)).toBe(true);
    expect(ordinaryPublicIp("2606:4700::1111",6)).toBe(true);
    let documentCalled = false;
    const mixed = (async (url: string) => {
      if (url.includes("dns-query")) return Response.json({Status:0,Answer:url.endsWith("type=1")?
        [{type:1,data:"8.8.8.8"},{type:1,data:"127.0.0.1"}]:[]});
      documentCalled = true; return Response.json(metadata);
    }) as typeof fetch;
    expect(await fetchClientMetadata(clientId,mixed)).toBeNull();
    expect(documentCalled).toBe(false);
    expect(await precheckCimdDns("client.example.com", (async()=>Response.json({Status:2})) as typeof fetch)).toBe(false);
    expect(await precheckCimdDns("client.example.com", (async()=>Response.json({Status:0,Answer:[]})) as typeof fetch)).toBe(false);
  });

  it("constructs DNS requests in the actual Workers runtime and never follows resolver redirects", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      // The Workers Vitest pool executes this Request constructor in workerd.
      // Mocking fetch alone previously hid the unsupported redirect:error mode.
      const request = new Request(url, init);
      calls.push(request.url);
      expect(request.redirect).toBe("manual");
      return url.startsWith("https://cloudflare-dns.com/dns-query?")
        ? dnsAnswer(url) : Response.json(metadata);
    }) as typeof fetch;
    expect(await fetchClientMetadata(clientId, fake)).toMatchObject({clientId});
    expect(calls).toHaveLength(3);
    expect(calls.filter(url => url.includes("dns-query"))).toHaveLength(2);

    for (const status of [301, 302, 307, 308, 204]) {
      let metadataCalled = false;
      const denied = (async (url: string, init: RequestInit) => {
        const request = new Request(url, init);
        expect(request.redirect).toBe("manual");
        if (!url.startsWith("https://cloudflare-dns.com/dns-query?")) {
          metadataCalled = true;
          return Response.json(metadata);
        }
        // A 3xx with syntactically valid public DNS JSON is still denied.
        return new Response(status === 204 ? null : JSON.stringify({
          Status: 0, Answer: url.endsWith("type=1") ? [{type:1,data:"8.8.8.8"}] : [],
        }), {status, headers:{location:"https://other.example.com/dns-query",
          "content-type":"application/dns-json"}});
      }) as typeof fetch;
      expect(await fetchClientMetadata(clientId, denied)).toBeNull();
      expect(metadataCalled).toBe(false);
    }
  });

  it("honors only bounded explicit public HTTP freshness", async () => {
    const now = Date.parse("2026-11-14T10:00:00Z");
    const headers = (cacheControl: string, extra: Record<string,string> = {}) =>
      new Headers({"cache-control":cacheControl,date:new Date(now).toUTCString(),...extra});
    expect(cimdFreshUntil(headers("public, max-age=300"),now,now)).toBe(now+300_000);
    expect(cimdFreshUntil(headers("public, max-age=3600"),now,now)).toBe(now+300_000);
    expect(cimdFreshUntil(headers("public, max-age=60"),now,now)).toBe(now+60_000);
    expect(cimdFreshUntil(headers("public, max-age=300, s-maxage=20"),now,now)).toBe(now+20_000);
    expect(cimdFreshUntil(headers("public, max-age=300",{age:"120"}),now-1000,now)).toBe(now+179_000);
    expect(cimdFreshUntil(headers("public, max-age=300",{date:new Date(now-60_000).toUTCString()}),now,now)).toBe(now+240_000);
    for (const directive of ["no-store", "public, no-store, max-age=300", "public, no-cache, max-age=300",
      "private, public, max-age=300", "public, max-age=0", "public, max-age=300, max-age=999",
      "max-age=300", "public", "public, max-age=-1", "public, max-age=abc"]) {
      expect(cimdFreshUntil(headers(directive),now,now)).toBeNull();
    }
    expect(cimdFreshUntil(headers("public, max-age=300",{"set-cookie":"x=1"}),now,now)).toBe(now+300_000);
    expect(cimdFreshUntil(headers("private, max-age=300",{"set-cookie":"x=1"}),now,now)).toBeNull();
    expect(cimdFreshUntil(headers("public, no-store, max-age=300",{"set-cookie":"x=1"}),now,now)).toBeNull();
    expect(cimdFreshUntil(headers("public, max-age=300",{"set-cookie":"x=1",vary:"Cookie"}),now,now)).toBeNull();
    const rejectedHeaders: Record<string,string>[] = [{age:"300"},{age:"bad"},{vary:"Accept"},{date:"bad"}];
    for (const extra of rejectedHeaders) {
      expect(cimdFreshUntil(headers("public, max-age=300",extra),now,now)).toBeNull();
    }
    const cookieResponse = (async (url: string, init: RequestInit) => {
      if (url.startsWith("https://cloudflare-dns.com/dns-query?")) return dnsAnswer(url);
      expect(init.redirect).toBe("manual");
      const sent = new Headers(init.headers);
      expect(sent.has("cookie")).toBe(false);
      expect(sent.has("authorization")).toBe(false);
      return Response.json(metadata,{headers:{"cache-control":"public, max-age=300","set-cookie":"test=discard"}});
    }) as typeof fetch;
    const fetched = await fetchClientMetadataResult(clientId,cookieResponse);
    expect(fetched).toMatchObject({ok:true,metadata:{clientId}});
    if (fetched.ok) {
      expect(fetched.freshUntilMs).toBeGreaterThan(Date.now());
      expect(JSON.stringify(fetched)).not.toContain("test=discard");
    }
    expect(await fetchClientMetadataResult(clientId,withDns(Response.json(metadata,{headers:{"cache-control":"no-store"}}))))
      .toMatchObject({ok:true,freshUntilMs:null});
    expect(await fetchClientMetadataResult(clientId,withDns(Response.json({...metadata,client_id:"wrong"},
      {headers:{"cache-control":"public, max-age=300"}}))))
      .toMatchObject({ok:false,reason:"metadata_invalid"});
  });

  it("classifies transient transport separately from security denials", async () => {
    expect(await fetchClientMetadataResult(clientId, withDns(new Response(null,{status:503}))))
      .toEqual({ok:false,reason:"metadata_http",retryable:true,status:503});
    expect(await fetchClientMetadataResult(clientId, withDns(new Response(null,{status:403}))))
      .toEqual({ok:false,reason:"metadata_http",retryable:false,status:403});
    expect(await fetchClientMetadataResult(clientId, withDns(new Response(null,{status:302}))))
      .toEqual({ok:false,reason:"metadata_http",retryable:false,status:302});
    expect(await fetchClientMetadataResult(clientId, withDns(Response.json({...metadata,client_id:"https://wrong.example.com/client.json"}))))
      .toEqual({ok:false,reason:"metadata_invalid",retryable:false});
    const mixed = (async (url: string) => {
      if (url.endsWith("type=1")) return dnsAnswer(url,"127.0.0.1");
      if (url.endsWith("type=28")) return new Response(null,{status:503});
      throw new Error("unsafe DNS result must prevent document fetch");
    }) as typeof fetch;
    expect(await fetchClientMetadataResult(clientId,mixed))
      .toEqual({ok:false,reason:"dns_target_denied",retryable:false});
    const temporary = (async () => Response.json({Status:2})) as typeof fetch;
    expect(await fetchClientMetadataResult(clientId,temporary))
      .toEqual({ok:false,reason:"dns_response",retryable:true});
  });

  it("never follows redirects, limits bytes and requires JSON media type", async () => {
    const calls: Array<{ url: string; redirect?: string }> = [];
    const fake = async (url: string, init: RequestInit) => {
      if (url.startsWith("https://cloudflare-dns.com/dns-query?")) return dnsAnswer(url);
      calls.push({ url, redirect: init.redirect });
      return new Response(JSON.stringify(metadata), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const read = await fetchClientMetadata(clientId, fake as typeof fetch);
    expect(read?.clientId).toBe(clientId);
    expect(calls).toEqual([{ url: clientId, redirect: "manual" }]);
    expect(await fetchClientMetadata(clientId, withDns(new Response(null, {
      status: 302, headers: { location: "https://evil.example.com/redirect" },
    })))).toBeNull();
    expect(await fetchClientMetadata(clientId, withDns(new Response("A".repeat(9000), {
      headers: { "content-type": "application/json" },
    })))).toBeNull();
    expect(await fetchClientMetadata(clientId, withDns(new Response(JSON.stringify(metadata), {
      headers: { "content-type": "text/html" },
    })))).toBeNull();
  });
});

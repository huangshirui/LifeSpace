import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import {
  configuredExternalProviderKeys,
  resolveExternalProviderRoute,
} from "../src/external-provider-router";
import {
  callExternalConnectionAdapter,
  listExternalProviderDescriptors,
} from "../src/external-connections";
import { callExternalAdapter, type ExternalSource } from "../src/external-model";

function providerAdapter(key: string, expectedSecret: string, calls: Array<Record<string, unknown>>): Fetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      expect(request.headers.get("x-lifespace-internal-secret")).toBe(expectedSecret);
      const body = await request.json<Record<string, unknown>>();
      expect(body.providerKey).toBe(key);
      calls.push({ path: new URL(request.url).pathname, ...body });
      if (body.operation === "describe") {
        return Response.json({ contractVersion: 1, data: {
          key,
          displayName: key === "notion" ? "Notion" : "Airtable",
          credential: { type: "bearer_token", displayName: "Token" },
          resource: { type: key === "notion" ? "data_source" : "table", displayName: key === "notion" ? "Data source" : "Table" },
          access: ["read", "write"],
        } });
      }
      if (body.operation === "create")
        return Response.json({ contractVersion: 1, data: { read: true, write: true } });
      if (body.operation === "discover")
        return Response.json({ contractVersion: 1, data: { marker: key } });
      return Response.json({ contractVersion: 1, data: { ok: true } });
    },
  } as Fetcher;
}

function routedEnv() {
  const notionCalls: Array<Record<string, unknown>> = [];
  const airtableCalls: Array<Record<string, unknown>> = [];
  const notionSecret = "notion-shared-secret-12345678901234567890";
  const airtableSecret = "airtable-shared-secret-123456789012345678";
  const env = {
    EXTERNAL_PROVIDER_ROUTES: JSON.stringify({
      notion: { binding: "EXTERNAL_ADAPTER_NOTION", sharedSecret: "EXTERNAL_ADAPTER_NOTION_SHARED_SECRET" },
      airtable: { binding: "EXTERNAL_ADAPTER_AIRTABLE", sharedSecret: "EXTERNAL_ADAPTER_AIRTABLE_SHARED_SECRET" },
    }),
    EXTERNAL_ADAPTER_NOTION: providerAdapter("notion", notionSecret, notionCalls),
    EXTERNAL_ADAPTER_NOTION_SHARED_SECRET: notionSecret,
    EXTERNAL_ADAPTER_AIRTABLE: providerAdapter("airtable", airtableSecret, airtableCalls),
    EXTERNAL_ADAPTER_AIRTABLE_SHARED_SECRET: airtableSecret,
  } as unknown as Bindings;
  return { env, notionCalls, airtableCalls };
}

describe("External Provider Router", () => {
  it("discovers multiple configured providers without sharing bindings or secrets", async () => {
    const { env, notionCalls, airtableCalls } = routedEnv();
    expect(configuredExternalProviderKeys(env)).toEqual(["airtable", "notion"]);
    const descriptors = await listExternalProviderDescriptors(env);
    expect(descriptors.map((item) => item.key)).toEqual(["airtable", "notion"]);
    expect(notionCalls).toHaveLength(1);
    expect(airtableCalls).toHaveLength(1);
    expect(resolveExternalProviderRoute(env, "notion")?.bindingName).toBe("EXTERNAL_ADAPTER_NOTION");
    expect(resolveExternalProviderRoute(env, "airtable")?.bindingName).toBe("EXTERNAL_ADAPTER_AIRTABLE");
  });

  it("routes Connection creation only to the selected provider", async () => {
    const { env, notionCalls, airtableCalls } = routedEnv();
    const result = await callExternalConnectionAdapter(env, {
      operation: "create",
      providerKey: "airtable",
      credentialRef: `cnx_${"a".repeat(32)}`,
      credential: { type: "bearer_token", token: "synthetic" },
      access: "write",
    });
    expect(result).toEqual({ read: true, write: true });
    expect(airtableCalls).toHaveLength(1);
    expect(notionCalls).toHaveLength(0);
  });

  it("routes External runtime by the stored source provider key", async () => {
    const { env, notionCalls, airtableCalls } = routedEnv();
    const source: ExternalSource = {
      id: `exs_${"b".repeat(32)}`,
      space_id: "spc_synthetic",
      provider_key: "airtable",
      credential_ref: `cnx_${"c".repeat(32)}`,
      status: "active",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    expect(await callExternalAdapter(env, source, "discover", "tbl_synthetic")).toEqual({ marker: "airtable" });
    expect(airtableCalls).toHaveLength(1);
    expect(notionCalls).toHaveLength(0);
  });

  it("fails closed for unknown and incompletely configured providers", async () => {
    const { env } = routedEnv();
    expect(() => resolveExternalProviderRoute(env, "google_sheets")).toThrowError(/External provider is not configured/);
    const broken = {
      EXTERNAL_PROVIDER_ROUTES: JSON.stringify({ notion: { binding: "EXTERNAL_ADAPTER_NOTION", sharedSecret: "EXTERNAL_ADAPTER_NOTION_SHARED_SECRET" } }),
    } as unknown as Bindings;
    expect(configuredExternalProviderKeys(broken)).toEqual([]);
    expect(() => resolveExternalProviderRoute(broken, "notion")).toThrowError(/External provider is unavailable/);
  });

  it("keeps the pre-routing Notion binding only as an explicit no-routing fallback", () => {
    const secret = "legacy-notion-secret-1234567890123456789012";
    const legacy = {
      EXTERNAL_ADAPTER: providerAdapter("notion", secret, []),
      EXTERNAL_ADAPTER_SHARED_SECRET: secret,
    } as unknown as Bindings;
    expect(configuredExternalProviderKeys(legacy)).toEqual(["notion"]);
    expect(resolveExternalProviderRoute(legacy, "notion")?.bindingName).toBe("EXTERNAL_ADAPTER");
    const routed = { ...legacy, EXTERNAL_PROVIDER_ROUTES: JSON.stringify({}) } as unknown as Bindings;
    expect(configuredExternalProviderKeys(routed)).toEqual([]);
  });
});

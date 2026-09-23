import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

describe("LifeSpace Identity foundation", () => {
  it("serves health without D1", async () => {
    const response = await createApp().request("http://localhost/health", {}, {} as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: "ok" } });
  });

  it("emits structured performance timing in deployed environments and honors the kill switch", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const measured = await createApp().request("http://localhost/health", {}, { ENVIRONMENT: "staging" } as any);
      expect(measured.status).toBe(200);
      const entries = log.mock.calls
        .map(([value]) => typeof value === "string" ? JSON.parse(value) : null)
        .filter((value) => value?.message === "LifeSpace performance timing");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ service: "identity", method: "GET", path: "/health", status: 200, phases: {} });
      expect(typeof entries[0].totalMs).toBe("number");

      log.mockClear();
      await createApp().request(
        "http://localhost/health",
        {},
        { ENVIRONMENT: "staging", PERFORMANCE_DIAGNOSTICS: "0" } as any,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("does not expose bootstrap application registration without the bootstrap secret", async () => {
    const response = await createApp().request(
      "http://localhost/bootstrap/v1/applications",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "app_test_identity", name: "Test Application", clientType: "mini_program", trustedBackend: true }),
      },
      { BOOTSTRAP_SECRET: "expected" } as any,
    );
    expect(response.status).toBe(401);
    const body = await response.json() as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("does not accept user assertions without a trusted application credential", async () => {
    const response = await createApp().request(
      "http://localhost/internal/v1/tokens",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectId: "usr_test", scopes: [] }),
      },
      {} as any,
    );
    expect(response.status).toBe(401);
    const body = await response.json() as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("does not accept user creation without a trusted application credential", async () => {
    const response = await createApp().request(
      "http://localhost/internal/v1/users",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Test" }),
      },
      {} as any,
    );
    expect(response.status).toBe(401);
    const body = await response.json() as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});

import { describe, expect, it } from "vitest";
import { createWebhookSigningSecret, validateWebhookUrl } from "../src/eventing";

describe("event webhook validation", () => {
  it("accepts public HTTPS destinations", () => {
    expect(validateWebhookUrl("https://automation.example.com/hooks/calendar")).toBe("https://automation.example.com/hooks/calendar");
  });

  it.each([
    "http://automation.example.com/hook",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.1/hook",
    "https://192.168.1.2/hook",
    "https://service.local/hook",
    "https://user:pass@example.com/hook",
  ])("rejects unsafe destination %s", (url) => {
    expect(() => validateWebhookUrl(url)).toThrow();
  });

  it("generates independent 256-bit signing secrets", () => {
    const first = createWebhookSigningSecret();
    const second = createWebhookSigningSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });
});

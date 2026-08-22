import { describe, expect, it } from "vitest";
import { createRegistryOpenAIProvider } from "../src/registry-openai-provider";

describe("Registry OpenAI provider model selection", () => {
  it("prioritizes domain intent over schema convenience", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = createRegistryOpenAIProvider({
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
      model: "test-model",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                result: { status: "choose_model", candidateModels: ["task", "wish"] },
              }),
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    await provider.generate({
      text: "明天记得交电费",
      currentInstant: "2026-08-21T12:00:00.000Z",
      spaceTimezone: "Asia/Shanghai",
      viewingTimezone: "Asia/Shanghai",
      responseSchema: { name: "test", strict: true, schema: { type: "object" } },
      models: [
        { key: "task", description: "Concrete work to complete" },
        { key: "wish", description: "Uncommitted aspiration" },
      ],
      people: [],
      requestingPersonRef: "p1",
    });

    expect(requestBody).not.toBeNull();
    const messages = requestBody?.messages as Array<{ role: string; content: string }>;
    const system = messages.find((message) => message.role === "system")?.content ?? "";
    expect(system).toContain("intended domain meaning first");
    expect(system).toContain("model description is the primary semantic contract");
    expect(system).toContain("Never select a broad or easy-to-fill schema");

    const user = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as { models?: unknown[] };
    expect(user.models).toEqual([
      { key: "task", description: "Concrete work to complete" },
      { key: "wish", description: "Uncommitted aspiration" },
    ]);
  });
});

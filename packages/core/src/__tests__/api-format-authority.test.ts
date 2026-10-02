// packages/core/src/__tests__/api-format-authority.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// pi-ai's getModel is mocked so resolveServiceModel does not depend on the registry.
vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn(() => undefined),
  getEnvApiKey: vi.fn(() => undefined),
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
  createAssistantMessageEventStream: vi.fn(),
}));

import { resolveServiceModel } from "../llm/service-resolver.js";
import { createLLMClient } from "../llm/provider.js";
import { LLMConfigSchema, type ApiFormat } from "../models/project.js";

// The single authority rule shared by resolveServiceModel and createLLMClient:
//   explicit apiFormat > preset/endpoint api > legacy openai-completions fallback.
describe("apiFormat authority", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-api-format-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function seedSecrets(services: Record<string, { apiKey: string }>) {
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({ services }));
  }

  function makeClient(service: string, model: string, apiFormat: ApiFormat | undefined, explicit: boolean) {
    return createLLMClient(LLMConfigSchema.parse({
      provider: service === "custom" ? "custom" : "openai",
      service,
      configSource: "studio",
      baseUrl: "https://llm.internal.corp/v1",
      apiKey: "sk-test",
      model,
      ...(apiFormat !== undefined ? { apiFormat } : {}),
      ...(explicit ? { apiFormatExplicit: true } : {}),
    }));
  }

  it("custom service: explicit chat/responses/anthropic agree between resolver and client", async () => {
    await seedSecrets({ "custom:内网GPT": { apiKey: "sk-corp" } });

    const cases: Array<[ApiFormat, string]> = [
      ["chat", "openai-completions"],
      ["responses", "openai-responses"],
      ["anthropic", "anthropic-messages"],
    ];
    for (const [format, expectedApi] of cases) {
      const resolved = await resolveServiceModel("custom:内网GPT", "gpt-4o", root, "https://llm.internal.corp/v1", format);
      const client = makeClient("custom", "gpt-4o", format, true);
      expect(resolved.model.api).toBe(expectedApi);
      expect(client._piModel?.api).toBe(expectedApi);
    }
  });

  it("non-custom service: explicit responses/anthropic override the preset in both", async () => {
    await seedSecrets({ minimax: { apiKey: "sk-minimax" } });

    for (const [format, expectedApi] of [["responses", "openai-responses"], ["anthropic", "anthropic-messages"]] as const) {
      const resolved = await resolveServiceModel("minimax", "MiniMax-M2.7", root, undefined, format);
      const client = makeClient("minimax", "MiniMax-M2.7", format, true);
      expect(resolved.model.api).toBe(expectedApi);
      expect(client._piModel?.api).toBe(expectedApi);
    }
  });

  it("non-custom service: auto-filled (non-explicit) apiFormat does not override the preset", async () => {
    await seedSecrets({ minimax: { apiKey: "sk-minimax" } });

    // config.apiFormat defaults to "chat" via schema; without apiFormatExplicit it must not
    // turn a non-custom service with an openai-completions preset into chat.
    const client = makeClient("minimax", "MiniMax-M2.7", undefined, false);
    expect(client._piModel?.api).toBe("openai-completions");
  });

  it("non-custom service: legacy fallback stays openai-completions when nothing configured", async () => {
    await seedSecrets({ minimax: { apiKey: "sk-minimax" } });

    const resolved = await resolveServiceModel("minimax", "MiniMax-M2.7", root);
    const client = makeClient("minimax", "MiniMax-M2.7", undefined, false);
    expect(resolved.model.api).toBe("openai-completions");
    expect(client._piModel?.api).toBe("openai-completions");
  });

  it("custom service: no explicit apiFormat still resolves to openai-completions in both", async () => {
    await seedSecrets({ "custom:内网GPT": { apiKey: "sk-corp" } });

    const resolved = await resolveServiceModel("custom:内网GPT", "gpt-4o", root, "https://llm.internal.corp/v1");
    const client = makeClient("custom", "gpt-4o", undefined, false);
    expect(resolved.model.api).toBe("openai-completions");
    expect(client._piModel?.api).toBe("openai-completions");
  });
});

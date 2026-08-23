import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { syncLLMConfig } from "../llm/config-sync.js";

function projectConfig(llm: Record<string, unknown>, extras: Record<string, unknown> = {}) {
  return {
    name: "sync-project",
    version: "0.1.0",
    language: "zh",
    notify: [{ type: "webhook", url: "https://example.test/hook", events: [] }],
    modelOverrides: { writer: "writer-model" },
    ...extras,
    llm,
  };
}

describe("syncLLMConfig", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function createProject(llm: Record<string, unknown>, env: string) {
    root = await mkdtemp(join(tmpdir(), "inkos-config-sync-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig(llm), null, 2) + "\n", "utf-8");
    await writeFile(join(root, ".env"), env, "utf-8");
  }

  it("maps a DeepSeek env setup to the service, model, base URL, provider, and derived protocol", async () => {
    await createProject(
      { provider: "custom", baseUrl: "https://old.example/v1", model: "old-model" },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_PROVIDER=openai\nINKOS_LLM_BASE_URL=https://api.deepseek.com\nINKOS_LLM_MODEL=deepseek-chat\nOTHER_SETTING=keep\n",
    );

    const result = await syncLLMConfig(root, { direction: "env-to-inkos", conflictPolicy: "source" });
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, any>;

    expect(result.wrote).toBe(true);
    expect(raw.llm.service).toBe("deepseek");
    expect(raw.llm.provider).toBe("openai");
    expect(raw.llm.defaultModel).toBe("deepseek-chat");
    expect(raw.llm.services[0]).toMatchObject({ service: "deepseek", apiFormat: "chat" });
    expect(raw.llm.services[0].baseUrl).toBe("https://api.deepseek.com");
    expect((await readFile(join(root, ".env"), "utf-8"))).toContain("OTHER_SETTING=keep");
  });

  it("syncs non-sensitive env values into Studio service config without copying the API key", async () => {
    await createProject(
      { provider: "openai", baseUrl: "https://old.example/v1", model: "old-model" },
      [
        "# keep this comment",
        "INKOS_LLM_SERVICE=anthropic",
        "INKOS_LLM_PROVIDER=anthropic",
        "INKOS_LLM_BASE_URL=https://gateway.example/anthropic",
        "INKOS_LLM_MODEL=claude-test-model",
        "INKOS_LLM_API_FORMAT=anthropic",
        "INKOS_LLM_STREAM=false",
        "INKOS_LLM_TEMPERATURE=0.4",
        "INKOS_LLM_THINKING_BUDGET=2048",
        "INKOS_LLM_EXTRA_top_p=0.9",
        "INKOS_LLM_API_KEY=",
        "OTHER_SETTING=keep",
        "",
      ].join("\n"),
    );

    const result = await syncLLMConfig(root, { direction: "env-to-inkos", conflictPolicy: "source" });
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, any>;
    const env = await readFile(join(root, ".env"), "utf-8");

    expect(result.wrote).toBe(true);
    expect(result.secret.sourcePresent).toBe(false);
    expect(result.secret.changed).toBe(false);
    expect(raw.llm.service).toBe("anthropic");
    expect(raw.llm.defaultModel).toBe("claude-test-model");
    expect(raw.llm.services).toEqual([{
      service: "anthropic",
      baseUrl: "https://gateway.example/anthropic",
      apiFormat: "anthropic",
      stream: false,
      temperature: 0.4,
    }]);
    expect(raw.llm.thinkingBudget).toBe(2048);
    expect(raw.llm.extra.top_p).toBe(0.9);
    expect(raw.notify[0].url).toBe("https://example.test/hook");
    expect(raw.modelOverrides.writer).toBe("writer-model");
    expect(JSON.stringify(raw)).not.toContain("apiKey");
    expect(env).toContain("OTHER_SETTING=keep");
    expect(env).toContain("# keep this comment");
  });

  it("syncs the selected Studio service into .env while preserving unrelated lines and secrets", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "custom:Gateway",
        provider: "custom",
        defaultModel: "gateway-model",
        services: [{
          service: "custom",
          name: "Gateway",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "responses",
          stream: true,
          temperature: 0.8,
        }],
        thinkingBudget: 1024,
        proxyUrl: "https://proxy.example",
      },
      [
        "# user comment",
        "OTHER_SETTING=keep",
        "INKOS_LLM_API_KEY=",
        "INKOS_LLM_MODEL=old-model",
        "",
      ].join("\n"),
    );

    const result = await syncLLMConfig(root, { direction: "inkos-to-env", conflictPolicy: "source" });
    const env = await readFile(join(root, ".env"), "utf-8");

    expect(result.wrote).toBe(true);
    expect(env).toContain("# user comment");
    expect(env).toContain("OTHER_SETTING=keep");
    expect(env).toContain("INKOS_LLM_API_KEY=");

    expect(env).toContain("INKOS_LLM_SERVICE=custom:Gateway");
    expect(env).toContain("INKOS_LLM_PROVIDER=custom");
    expect(env).toContain("INKOS_LLM_BASE_URL=https://gateway.example/v1");
    expect(env).toContain("INKOS_LLM_MODEL=gateway-model");
    expect(env).toContain("INKOS_LLM_API_FORMAT=responses");
    expect(env).toContain("INKOS_LLM_STREAM=true");
    expect(env).toContain("INKOS_LLM_TEMPERATURE=0.8");
    expect(env).toContain("INKOS_LLM_THINKING_BUDGET=1024");
    expect(env).toContain("INKOS_LLM_PROXY_URL=https://proxy.example");
    expect(env).not.toContain("apiKey");
    expect(env.split("OTHER_SETTING=keep").length).toBe(2);
  });

  it("blocks conflicting values by default and leaves both files unchanged", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "moonshot",
        defaultModel: "inkos-model",
        services: [{ service: "moonshot" }],
      },
      "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_MODEL=env-model\nOTHER_SETTING=keep\n",
    );
    const beforeConfig = await readFile(join(root, "inkos.json"), "utf-8");
    const beforeEnv = await readFile(join(root, ".env"), "utf-8");

    const result = await syncLLMConfig(root, { direction: "env-to-inkos", write: true });

    expect(result.wrote).toBe(false);
    expect(result.conflicts).toContain("model");
    await expect(readFile(join(root, "inkos.json"), "utf-8")).resolves.toBe(beforeConfig);
    await expect(readFile(join(root, ".env"), "utf-8")).resolves.toBe(beforeEnv);
  });

  it("supports explicit source conflict resolution and reports preview without writing", async () => {
    await createProject(
      { provider: "openai", model: "inkos-model", baseUrl: "https://inkos.example/v1" },
      "INKOS_LLM_PROVIDER=openai\nINKOS_LLM_MODEL=env-model\nINKOS_LLM_BASE_URL=https://env.example/v1\n",
    );

    const preview = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
      write: false,
    });
    expect(preview.wrote).toBe(false);
    expect(preview.changed).toBe(false);
    expect(preview.changes.some((change) => change.action === "update")).toBe(true);

    const applied = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
    });
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, any>;
    expect(applied.wrote).toBe(true);
    expect(raw.llm.defaultModel).toBe("env-model");
    expect(raw.llm.baseUrl).toBe("https://env.example/v1");
  });

  it("treats matching custom service names as a no-op", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "custom:Kiro(2)",
        provider: "openai",
        baseUrl: "https://api.zhongzhuan.win/v1",
        model: "claude-opus-4-6",
        apiFormat: "chat",
        stream: true,
        services: [{
          service: "custom",
          name: "Kiro(2)",
          baseUrl: "https://api.zhongzhuan.win/v1",
          models: ["claude-opus-4-6"],
          temperature: 0.7,
          apiFormat: "chat",
          stream: true,
        }],
        defaultModel: "claude-opus-4-6",
        temperature: 0.7,
      },
      "INKOS_LLM_SERVICE=\"custom:Kiro(2)\"\nINKOS_LLM_PROVIDER=openai\nINKOS_LLM_BASE_URL=https://api.zhongzhuan.win/v1\nINKOS_LLM_MODEL=claude-opus-4-6\nINKOS_LLM_API_FORMAT=chat\nINKOS_LLM_STREAM=true\nINKOS_LLM_TEMPERATURE=0.7\n",
    );
    const before = await readFile(join(root, ".env"), "utf-8");

    const result = await syncLLMConfig(root, { direction: "inkos-to-env" });

    expect(result.wrote).toBe(false);
    expect(result.changed).toBe(false);
    await expect(readFile(join(root, ".env"), "utf-8")).resolves.toBe(before);
  });

  it("treats an already matching configuration as a no-op", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "moonshot",
        provider: "openai",
        defaultModel: "kimi-k2.5",
        services: [{ service: "moonshot", apiFormat: "chat", stream: true }],
      },
      "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_PROVIDER=openai\nINKOS_LLM_BASE_URL=https://api.moonshot.cn/v1\nINKOS_LLM_MODEL=kimi-k2.5\nINKOS_LLM_API_FORMAT=chat\nINKOS_LLM_STREAM=true\n",
    );
    const before = await readFile(join(root, "inkos.json"), "utf-8");
    const beforeStat = await stat(join(root, "inkos.json"));

    const result = await syncLLMConfig(root, { direction: "env-to-inkos" });

    expect(result.wrote).toBe(false);
    expect(result.changed).toBe(false);
    await expect(readFile(join(root, "inkos.json"), "utf-8")).resolves.toBe(before);
    expect((await stat(join(root, "inkos.json"))).mtimeMs).toBe(beforeStat.mtimeMs);
  });
});

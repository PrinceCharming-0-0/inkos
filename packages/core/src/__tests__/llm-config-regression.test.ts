import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { saveSecrets } from "../llm/secrets.js";
import { resolveEffectiveLLMConfig } from "../utils/effective-llm-config.js";
import { loadProjectConfig } from "../utils/config-loader.js";
import { syncLLMConfig } from "../llm/config-sync.js";

function config(llm: Record<string, unknown>) {
  return {
    name: "regression-project",
    version: "0.1.0",
    language: "zh",
    notify: [],
    llm,
  };
}

describe("LLM config synchronization regression scenarios", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("supports a Studio config backed only by .inkos/secrets.json without exposing the secret", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-regression-secret-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(config({
      configSource: "studio",
      service: "moonshot",
      defaultModel: "kimi-k2.5",
      services: [{ service: "moonshot" }],
    }), null, 2) + "\n", "utf-8");
    await saveSecrets(root, { services: { moonshot: { apiKey: "fixture-only-secret" } } });
    const beforeConfig = await readFile(join(root, "inkos.json"), "utf-8");

    const loaded = await loadProjectConfig(root, { consumer: "studio" });
    const syncPreview = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      write: false,
    });

    expect(loaded.llm.service).toBe("moonshot");
    expect(loaded.llm.model).toBe("kimi-k2.5");
    expect(loaded.llm.apiKey).toBe("fixture-only-secret");
    expect(syncPreview.secret.targetPresent).toBe(true);
    expect(JSON.stringify(syncPreview)).not.toContain("fixture-only-secret");
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(beforeConfig);
  });

  it("keeps missing .env as a no-op for env-to-inkos and does not change the file timestamp", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-regression-no-env-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(config({
      provider: "openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "local-model",
    }), null, 2) + "\n", "utf-8");
    const before = await stat(join(root, "inkos.json"));

    const result = await syncLLMConfig(root, { direction: "env-to-inkos" });

    expect(result.wrote).toBe(false);
    expect(result.changed).toBe(false);
    expect((await stat(join(root, "inkos.json"))).mtimeMs).toBe(before.mtimeMs);
  });

  it("fails without inkos.json or with invalid JSON without changing the other file", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-regression-invalid-config-"));
    const envContent = "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_MODEL=deepseek-chat\nOTHER_SETTING=keep\n";
    await writeFile(join(root, ".env"), envContent, "utf-8");

    await expect(syncLLMConfig(root, { direction: "env-to-inkos" })).rejects.toThrow(/inkos\.json|ENOENT|no such file/i);
    await expect(readFile(join(root, ".env"), "utf-8")).resolves.toBe(envContent);

    await writeFile(join(root, "inkos.json"), "{ invalid json", "utf-8");
    await expect(syncLLMConfig(root, { direction: "env-to-inkos" })).rejects.toThrow(/JSON|unexpected/i);
    await expect(readFile(join(root, ".env"), "utf-8")).resolves.toBe(envContent);
  });

  it("does not persist CLI temporary service/model overrides", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-regression-overrides-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(config({
      configSource: "studio",
      service: "moonshot",
      defaultModel: "kimi-k2.5",
      services: [{ service: "moonshot" }, { service: "google" }],
    }), null, 2) + "\n", "utf-8");
    await writeFile(join(root, ".env"), "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_MODEL=kimi-k2.5\n", "utf-8");
    const beforeConfig = await readFile(join(root, "inkos.json"), "utf-8");
    const beforeEnv = await readFile(join(root, ".env"), "utf-8");

    const result = await resolveEffectiveLLMConfig({
      consumer: "cli",
      projectRoot: root,
      envLayers: {
        global: {},
        project: { INKOS_LLM_SERVICE: "google", INKOS_LLM_MODEL: "gemini-2.5-flash" },
        process: {},
      },
      cli: { service: "moonshot", model: "kimi-k2.5" },
      requireApiKey: false,
    });

    expect(result.llm.service).toBe("moonshot");
    expect(result.llm.model).toBe("kimi-k2.5");
    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(beforeConfig);
    expect(await readFile(join(root, ".env"), "utf-8")).toBe(beforeEnv);
  });

  it("does not write during ordinary Studio config reads", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-regression-read-only-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(config({
      configSource: "studio",
      service: "ollama",
      defaultModel: "local-model",
      services: [{ service: "ollama" }],
    }), null, 2) + "\n", "utf-8");
    await mkdir(join(root, ".inkos"), { recursive: true });
    await writeFile(join(root, ".inkos", "secrets.json"), JSON.stringify({ services: {} }) + "\n", "utf-8");
    const beforeConfig = await readFile(join(root, "inkos.json"), "utf-8");
    const beforeSecrets = await readFile(join(root, ".inkos", "secrets.json"), "utf-8");
    const beforeConfigStat = await stat(join(root, "inkos.json"));
    const beforeSecretsStat = await stat(join(root, ".inkos", "secrets.json"));

    await loadProjectConfig(root, { consumer: "studio", requireApiKey: false });

    expect(await readFile(join(root, "inkos.json"), "utf-8")).toBe(beforeConfig);
    expect(await readFile(join(root, ".inkos", "secrets.json"), "utf-8")).toBe(beforeSecrets);
    expect((await stat(join(root, "inkos.json"))).mtimeMs).toBe(beforeConfigStat.mtimeMs);
    expect((await stat(join(root, ".inkos", "secrets.json"))).mtimeMs).toBe(beforeSecretsStat.mtimeMs);
  });
});

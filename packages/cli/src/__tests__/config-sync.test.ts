import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(testDir, "..", "..");
const cliEntry = resolve(cliDir, "dist", "index.js");

describe("inkos config sync", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  function env() {
    return Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("INKOS_") && key !== "TAVILY_API_KEY"),
    );
  }

  function run(args: string[]): string {
    return execFileSync("node", [cliEntry, ...args], {
      cwd: root,
      encoding: "utf-8",
      env: { ...env(), HOME: root },
      timeout: 10_000,
    });
  }

  it("supports preview and explicit env-to-inkos synchronization", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-cli-sync-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "cli-sync",
      version: "0.1.0",
      language: "zh",
      llm: { provider: "openai", baseUrl: "https://old.example/v1", model: "old-model" },
      notify: [],
    }, null, 2) + "\n", "utf-8");
    await writeFile(join(root, ".env"), [
      "# keep",
      "INKOS_LLM_SERVICE=moonshot",
      "INKOS_LLM_PROVIDER=openai",
      "INKOS_LLM_BASE_URL=https://api.moonshot.cn/v1",
      "INKOS_LLM_MODEL=cli-model",
      "INKOS_LLM_API_KEY=",
      "OTHER_SETTING=keep",
      "",
    ].join("\n"), "utf-8");

    const preview = run(["config", "sync", "--from", "env", "--preview", "--on-conflict", "source"]);
    expect(preview).toContain("Preview");
    expect(preview).not.toContain("apiKey");

    expect(JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")).llm.model).toBe("old-model");

    const output = run(["config", "sync", "--from", "env", "--on-conflict", "source"]);
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, any>;
    expect(output).toContain("Synced");
    expect(output).not.toContain("apiKey");

    expect(config.llm.defaultModel).toBe("cli-model");
    expect(config.llm.services[0].service).toBe("moonshot");
    expect(JSON.stringify(config)).not.toContain("apiKey");

  });

  it("applies differing values as updates by default without --on-conflict", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-cli-sync-update-"));
    const configContent = JSON.stringify({
      name: "cli-sync-update",
      version: "0.1.0",
      llm: { configSource: "studio", service: "moonshot", defaultModel: "inkos-model", services: [{ service: "moonshot" }] },
      notify: [],
    }, null, 2) + "\n";
    const envContent = "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_MODEL=env-model\n";
    await writeFile(join(root, "inkos.json"), configContent, "utf-8");
    await writeFile(join(root, ".env"), envContent, "utf-8");

    // Default policy: the env-declared model difference is a plain update.
    const output = run(["config", "sync", "--from", "env"]);

    expect(output).toContain("Synced");
    expect(output).not.toContain("Conflicts");
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, any>;
    expect(config.llm.defaultModel).toBe("env-model");
  });

  it("keeps existing target values with --on-conflict target", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-cli-sync-target-"));
    const configContent = JSON.stringify({
      name: "cli-sync-target",
      version: "0.1.0",
      llm: { configSource: "studio", service: "moonshot", defaultModel: "inkos-model", services: [{ service: "moonshot" }] },
      notify: [],
    }, null, 2) + "\n";
    const envContent = "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_MODEL=env-model\n";
    await writeFile(join(root, "inkos.json"), configContent, "utf-8");
    await writeFile(join(root, ".env"), envContent, "utf-8");

    const output = run(["config", "sync", "--from", "env", "--on-conflict", "target"]);

    expect(output).toContain("No changes");
    const config = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as Record<string, any>;
    expect(config.llm.defaultModel).toBe("inkos-model");
  });
});

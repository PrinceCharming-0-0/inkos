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

  it("returns a conflict failure without changing files", async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-cli-sync-conflict-"));
    const configContent = JSON.stringify({
      name: "cli-sync-conflict",
      version: "0.1.0",
      llm: { configSource: "studio", service: "moonshot", defaultModel: "inkos-model", services: [{ service: "moonshot" }] },
      notify: [],
    }, null, 2) + "\n";
    const envContent = "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_MODEL=env-model\n";
    await writeFile(join(root, "inkos.json"), configContent, "utf-8");
    await writeFile(join(root, ".env"), envContent, "utf-8");

    let exitCode = 0;
    let output = "";
    try {
      output = run(["config", "sync", "--from", "env"]);
    } catch (error) {
      exitCode = (error as { status?: number }).status ?? 1;
      output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("Conflicts: model");
    await expect(readFile(join(root, "inkos.json"), "utf-8")).resolves.toBe(configContent);
    await expect(readFile(join(root, ".env"), "utf-8")).resolves.toBe(envContent);
  });
});

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { syncLLMConfig } from "../llm/config-sync.js";
import { saveSecrets } from "../llm/secrets.js";

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

function svcEntries(llm: unknown): Array<{ service: string; name?: string }> {
  const services = (llm as Record<string, unknown>)?.services;
  if (!Array.isArray(services)) return [];
  return services.map((e) => ({
    service: String((e as Record<string, unknown>).service ?? ""),
    name: (e as Record<string, unknown>).name as string | undefined,
  }));
}

function svcKey(svc: { service: string; name?: string }): string {
  return svc.service === "custom" ? `custom:${svc.name ?? "Custom"}` : svc.service;
}

describe("syncLLMConfig service-change integrity", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function createProject(
    llm: Record<string, unknown>,
    env: string,
    secrets?: Record<string, { apiKey: string }>,
  ) {
    root = await mkdtemp(join(tmpdir(), "inkos-service-change-"));
    await writeFile(join(root, "inkos.json"), JSON.stringify(projectConfig(llm), null, 2) + "\n");
    await writeFile(join(root, ".env"), env);
    if (secrets) {
      await mkdir(join(root, ".inkos"), { recursive: true });
      await saveSecrets(root, { services: secrets });
    }
    return root;
  }

  // ─── TC1: A→B switch replaces the previous selected entry, does not duplicate ───
  it("env-to-inkos A→B replaces previous selected entry, does not duplicate", async () => {
    // Studio has custom:Gateway selected; .env points to deepseek
    await createProject(
      {
        configSource: "studio",
        service: "custom:Gateway",
        services: [{ service: "custom", name: "Gateway", baseUrl: "https://old.example/v1" }],
        defaultModel: "old-model",
      },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_BASE_URL=https://api.deepseek.com\nINKOS_LLM_MODEL=deepseek-chat\nINKOS_LLM_PROVIDER=openai\n",
    );

    const result = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
    });

    expect(result.wrote).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const entries = svcEntries(raw.llm);
    const keys = entries.map(svcKey);

    // Must have exactly one deepseek entry (not deepseek + Gateway)
    expect(keys).toContain("deepseek");
    expect(keys.filter((k) => k === "deepseek").length).toBe(1);
    // The old selected custom entry must be gone
    expect(keys).not.toContain("custom:Gateway");
    // Selected service must be deepseek
    expect(raw.llm.service).toBe("deepseek");
    // Non-selected mooted entries must not appear (no duplicates)
    expect(entries.length).toBe(1);
  });

  // ─── TC2: A→B where old has key, new has none → key warning reported ─────────
  it("reports missing key for new service when previous service had the key", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "custom:Gateway",
        services: [{ service: "custom", name: "Gateway", baseUrl: "https://old.example/v1" }],
        defaultModel: "m",
      },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_BASE_URL=https://api.deepseek.com\nINKOS_LLM_MODEL=deepseek-chat\n",
      { "custom:Gateway": { apiKey: "sk-old-key" } },
    );

    const result = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
    });

    expect(result.wrote).toBe(true);
  // direction=env-to-inkos: source = .env side, target = inkos.json side
    // New service deepseek has no key in secrets → targetPresent should be false
    expect(result.secret.targetPresent).toBe(false);
    // Source (.env) has no key either
    expect(result.secret.sourcePresent).toBe(false);
    // warnings field should contain the key-gap message
    expect(result.warnings.some((w) => w.includes("no saved API key"))).toBe(true);
  });

  // ─── TC3: multi-service bank — syncing selected service must not touch others ───
  it("env-to-inkos only replaces the previous selected entry; unrelated entries stay", async () => {
    // Studio has moonshot + bailian; .env points to deepseek
    await createProject(
      {
        configSource: "studio",
        service: "moonshot",
        services: [
          { service: "moonshot" },
          { service: "bailian" },
        ],
        defaultModel: "kimi",
      },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_BASE_URL=https://api.deepseek.com\nINKOS_LLM_MODEL=deepseek-chat\nINKOS_LLM_PROVIDER=openai\n",
    );

    const result = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
    });

    expect(result.wrote).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const entries = svcEntries(raw.llm);
    const keys = entries.map(svcKey);

    // deepseek is the new selected
    expect(raw.llm.service).toBe("deepseek");
    expect(keys).toContain("deepseek");
    // moonshot was the previous selected → removed
    expect(keys).not.toContain("moonshot");
    // bailian was never selected → must survive
    expect(keys).toContain("bailian");
    expect(entries.length).toBe(2); // deepseek + bailian
  });

  // ─── TC4: custom service rename (custom:Old → custom:New) replaces old entry ─
  it("custom service rename replaces the previous custom entry", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "custom:OldProxy",
        services: [{ service: "custom", name: "OldProxy", baseUrl: "https://old.example/v1", apiFormat: "chat" }],
        defaultModel: "m",
      },
      "INKOS_LLM_SERVICE=\"custom:NewProxy\"\nINKOS_LLM_BASE_URL=https://new.example/v1\nINKOS_LLM_MODEL=m\nINKOS_LLM_API_FORMAT=chat\n",
    );

    const result = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
    });

    expect(result.wrote).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const entries = svcEntries(raw.llm);
    const keys = entries.map(svcKey);

    expect(raw.llm.service).toBe("custom:NewProxy");
    expect(keys).toContain("custom:NewProxy");
    expect(keys).not.toContain("custom:OldProxy");
    expect(entries.length).toBe(1);
  });

  // ─── TC5: model deletion survives sync (regression for 2773e5d) ──────────────
  // Note: INKOS_LLM_MODEL= (empty) is treated as "unset" by stringValue, so it does
  // not itself trigger a write. The sync is a no-op when all fields already match.
  // The key guarantee is that an empty models array in inkos.json is not restored
  // by a no-op sync pass.
  it("model deletion — empty list is not restored by a no-op sync pass", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "moonshot",
        services: [{ service: "moonshot", models: [] }],
        defaultModel: "",
      },
      "INKOS_LLM_SERVICE=moonshot\nINKOS_LLM_MODEL=\n",
    );

    const result = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      conflictPolicy: "source",
    });

    // Empty model var is "unset" → no mismatch → no write
    expect(result.wrote).toBe(false);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    // Empty models array must survive the no-op pass
    expect(Array.isArray(raw.llm.services[0]?.models)).toBe(true);
    expect(raw.llm.services[0].models).toHaveLength(0);
  });

  // ─── TC6: secret presence per-side judgment (not "either → true") ─────────────
  it("source/target secret presence is per-side, not aggregated", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "moonshot",
        services: [{ service: "moonshot" }],
        defaultModel: "m",
      },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_MODEL=m\nINKOS_LLM_API_KEY=sk-env-key\n",
      { moonshot: { apiKey: "sk-studio-key" } },
    );

    // Preview without writing: a service difference is now an update, not a
    // conflict, but secret presence is still judged per-side per-service.
    const result = await syncLLMConfig(root, {
      direction: "env-to-inkos",
      write: false,
    });

    // The service difference is a plain update under the chosen direction.
    const serviceChange = result.changes.find((change) => change.field === "service");
    expect(serviceChange?.action).toBe("update");
    expect(result.conflicts).toEqual([]);
    // direction=env-to-inkos: source = .env, target = inkos
    // .env has INKOS_LLM_API_KEY → sourcePresent must be true
    expect(result.secret.sourcePresent).toBe(true);
    // After sync the inkos side will select deepseek; secrets has a moonshot
    // key but NOT a deepseek key → targetPresent must be false.
    expect(result.secret.targetPresent).toBe(false);
    // Preview must also surface the service-switch consequences.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('from "moonshot" to "deepseek"');
    expect(result.warnings[0]).toContain("no saved API key");
    expect(result.warnings[0]).toContain("not moved or deleted");
  });

  // ─── TC6b: A→B switch works under the default policy with warnings intact ────
  it("performs A→B service switch under default policy and reports the key gap", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "custom:Gateway",
        services: [{ service: "custom", name: "Gateway", baseUrl: "https://old.example/v1" }],
        defaultModel: "old-model",
      },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_BASE_URL=https://api.deepseek.com\nINKOS_LLM_MODEL=deepseek-chat\n",
      { "custom:Gateway": { apiKey: "sk-old-key" } },
    );

    // No conflictPolicy passed at all: the switch must still work end to end.
    const result = await syncLLMConfig(root, { direction: "env-to-inkos" });

    expect(result.wrote).toBe(true);
    expect(result.conflicts).toEqual([]);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const keys = svcEntries(raw.llm).map(svcKey);
    expect(raw.llm.service).toBe("deepseek");
    expect(keys).toEqual(["deepseek"]);
    // Old service key is never moved or copied; the gap is reported.
    expect(result.secret.targetPresent).toBe(false);
    expect(result.warnings.some((w) => w.includes("no saved API key"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("not moved or deleted"))).toBe(true);
    const secretsRaw = JSON.parse(await readFile(join(root, ".inkos", "secrets.json"), "utf-8"));
    expect(secretsRaw.services["custom:Gateway"].apiKey).toBe("sk-old-key");
    expect(secretsRaw.services.deepseek).toBeUndefined();
  });

  // ─── TC7: identical config produces no-op on first pass (preset-derived values) ─
  // When inkos.json and .env are semantically aligned (env values match preset
  // defaults for the selected service), the first sync pass is already a no-op.
  it("re-running sync on semantically identical config stays no-op", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "deepseek",
        services: [{ service: "deepseek" }],
        defaultModel: "deepseek-chat",
      },
      "INKOS_LLM_SERVICE=deepseek\nINKOS_LLM_BASE_URL=https://api.deepseek.com\nINKOS_LLM_MODEL=deepseek-chat\nINKOS_LLM_PROVIDER=openai\n",
    );

    // First pass: preset-derived baseUrl matches env exactly → no mismatch → no write
    const r1 = await syncLLMConfig(root, { direction: "env-to-inkos", conflictPolicy: "source" });
    expect(r1.wrote).toBe(false);
    expect(r1.changed).toBe(false);

    // Second pass: inkos.json unchanged → definitely no-op
    const r2 = await syncLLMConfig(root, { direction: "env-to-inkos", conflictPolicy: "source" });
    expect(r2.wrote).toBe(false);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const entries = svcEntries(raw.llm);
    expect(entries.length).toBe(1);
    expect(entries.map(svcKey)).toContain("deepseek");
  });

  // ─── TC8: inkos-to-env does not mutate services array ────────────────────────
  it("inkos-to-env leaves service list intact in inkos.json", async () => {
    await createProject(
      {
        configSource: "studio",
        service: "custom:Gateway",
        services: [{ service: "custom", name: "Gateway", baseUrl: "https://g.example/v1", apiFormat: "responses", stream: true, temperature: 0.8 }],
        defaultModel: "m",
      },
      "# keep\nOTHER=keep\n",
    );

    const result = await syncLLMConfig(root, {
      direction: "inkos-to-env",
      conflictPolicy: "source",
    });

    expect(result.wrote).toBe(true);
    const raw = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8"));
    const entries = svcEntries(raw.llm);
    const keys = entries.map(svcKey);
    // Service list must be exactly what it was before
    expect(keys).toEqual(["custom:Gateway"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  applyDiscoveredServiceDetailModels,
  deleteServiceConfig,
  deriveServiceDetailModelView,
  matchServiceConfigEntryForDetail,
  mergeServiceDetailModels,
  rehydrateServiceConnectionStatus,
  removeServiceDetailModel,
  resolveServiceDetailIdentity,
  saveServiceConfig,
} from "./service-detail-state";

describe("mergeServiceDetailModels", () => {
  it("keeps discovered and user-added models in one stable catalog", () => {
    expect(mergeServiceDetailModels(
      [{ id: "MiniMax-M2.7" }],
      ["minimax-m2.7", "MiniMax-M2.8"],
    )).toEqual([
      { id: "MiniMax-M2.7" },
      { id: "MiniMax-M2.8" },
    ]);
  });
});

describe("rehydrateServiceConnectionStatus", () => {
  it("loads saved key without probing models on page load", async () => {
    const fetchJsonImpl = vi.fn(async (path: string) => {
      if (path === "/services/openai/secret") {
        return { apiKey: "sk-live" };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await rehydrateServiceConnectionStatus({
      effectiveServiceId: "openai",
      shouldVerify: true,
      isCustom: false,
      baseUrl: "",
      apiFormat: "chat",
      stream: true,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(fetchJsonImpl).toHaveBeenCalledTimes(1);
    expect(fetchJsonImpl).toHaveBeenCalledWith("/services/openai/secret");
    expect(result).toMatchObject({
      apiKey: "sk-live",
      detectedModel: "",
      detectedConfig: null,
      status: { state: "idle" },
    });
  });
});

describe("matchServiceConfigEntryForDetail", () => {
  const entries = [
    { service: "moonshot", temperature: 0.5 },
    { service: "custom", name: "内网GPT", baseUrl: "https://llm.internal.corp/v1" },
    { service: "custom", name: "本地Ollama", baseUrl: "http://localhost:11434/v1" },
  ];

  it("matches concrete custom services without treating bare custom as an existing config", () => {
    expect(matchServiceConfigEntryForDetail(entries, "custom")).toBeUndefined();
    expect(matchServiceConfigEntryForDetail(entries, "custom:内网GPT")).toEqual(entries[1]);
  });

  it("matches non-custom services by service id", () => {
    expect(matchServiceConfigEntryForDetail(entries, "moonshot")).toEqual(entries[0]);
  });
});

describe("saveServiceConfig", () => {
  it("shows a plain error when API key is empty", async () => {
    await expect(saveServiceConfig({
      effectiveServiceId: "openai",
      serviceId: "openai",
      isCustom: false,
      resolvedCustomName: "",
      apiKey: "",
      baseUrl: "",
      apiFormat: "chat",
      stream: true,
      temperature: "0.7",
      detectedModel: "",
    })).resolves.toMatchObject({
      status: {
        state: "error",
        message: "请先输入 API Key",
      },
    });
  });

  it("round-trips an anthropic api format selection through save without changing protocol", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetchJsonImpl = vi.fn(async (path: string, init?: { body?: string }) => {
      calls.push(path);
      if (init?.body) bodies.push(JSON.parse(init.body));
      if (path === "/services/custom%3AAnthropicGW/test") {
        return {
          ok: true,
          models: [{ id: "claude-sonnet-4-5" }],
          selectedModel: "claude-sonnet-4-5",
          detected: { apiFormat: "anthropic", stream: false, baseUrl: "https://llm.internal.corp" },
        };
      }
      if (path === "/services/custom%3AAnthropicGW/secret") return { ok: true };
      if (path === "/services/config") return { ok: true };
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await saveServiceConfig({
      effectiveServiceId: "custom:AnthropicGW",
      serviceId: "custom",
      isCustom: true,
      resolvedCustomName: "AnthropicGW",
      apiKey: "",
      baseUrl: "https://llm.internal.corp",
      apiFormat: "anthropic",
      stream: true,
      temperature: "0.7",
      detectedModel: "",
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(result.detectedConfig?.apiFormat).toBe("anthropic");
    // New custom service: config is accepted by the server before the secret is written.
    expect(calls).toEqual([
      "/services/custom%3AAnthropicGW/test",
      "/services/config",
      "/services/custom%3AAnthropicGW/secret",
    ]);
    const savedConfig = bodies[1] as { services: Array<{ apiFormat?: string }> };
    expect(savedConfig.services[0]?.apiFormat).toBe("anthropic");
  });

  it("allows a built-in local service to validate and save without an API key", async () => {
    const calls: string[] = [];
    const fetchJsonImpl = vi.fn(async (path: string) => {
      calls.push(path);
      if (path === "/services/lmstudio/test") {
        return {
          ok: true,
          models: [{ id: "qwen3-30b" }],
          selectedModel: "qwen3-30b",
          detected: { apiFormat: "chat", stream: true },
        };
      }
      if (path === "/services/lmstudio/secret") return { ok: true };
      if (path === "/services/config") return { ok: true };
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await saveServiceConfig({
      effectiveServiceId: "lmstudio",
      serviceId: "lmstudio",
      isCustom: false,
      apiKeyOptional: true,
      resolvedCustomName: "",
      apiKey: "",
      baseUrl: "",
      apiFormat: "chat",
      stream: true,
      temperature: "0.7",
      detectedModel: "",
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(calls).toEqual([
      "/services/lmstudio/test",
      "/services/lmstudio/secret",
      "/services/config",
    ]);
    expect(result).toMatchObject({
      status: { state: "connected", models: [{ id: "qwen3-30b" }] },
      detectedModel: "qwen3-30b",
    });
  });

  it("validates the upstream service before persisting secrets/config", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetchJsonImpl = vi.fn(async (path: string, init?: { body?: string }) => {
      calls.push(path);
      if (init?.body) bodies.push(JSON.parse(init.body));
      if (path === "/services/openai/test") {
        return {
          ok: true,
          models: [{ id: "gpt-5.5" }],
          selectedModel: "gpt-5.5",
          detected: { apiFormat: "chat", stream: true },
        };
      }
      if (path === "/services/openai/secret") return { ok: true };
      if (path === "/services/config") return { ok: true };
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await saveServiceConfig({
      effectiveServiceId: "openai",
      serviceId: "openai",
      isCustom: false,
      resolvedCustomName: "",
      apiKey: "sk-live",
      baseUrl: "",
      apiFormat: "chat",
      stream: true,
      temperature: "0.7",
      detectedModel: "",
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(calls).toEqual([
      "/services/openai/test",
      "/services/openai/secret",
      "/services/config",
    ]);
    expect(bodies).toEqual([
      { apiKey: "sk-live", apiFormat: "chat", stream: true },
      { apiKey: "sk-live" },
      {
        service: "openai",
        defaultModel: "gpt-5.5",
        services: [
          { service: "openai", temperature: 0.7, apiFormat: "chat", stream: true, models: ["gpt-5.5"] },
        ],
      },
    ]);
    expect(result).toEqual({
      detectedModel: "gpt-5.5",
      detectedConfig: { apiFormat: "chat", stream: true },
      status: { state: "connected", models: [{ id: "gpt-5.5" }] },
    });
  });

  it("reuses a matching successful test result when saving", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetchJsonImpl = vi.fn(async (path: string, init?: { body?: string }) => {
      calls.push(path);
      if (init?.body) bodies.push(JSON.parse(init.body));
      if (path === "/services/openai/secret") return { ok: true };
      if (path === "/services/config") return { ok: true };
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await saveServiceConfig({
      effectiveServiceId: "openai",
      serviceId: "openai",
      isCustom: false,
      resolvedCustomName: "",
      apiKey: "sk-live",
      baseUrl: "",
      apiFormat: "chat",
      stream: true,
      temperature: "0.7",
      detectedModel: "",
      verifiedProbe: {
        apiKey: "sk-live",
        baseUrl: "",
        apiFormat: "chat",
        stream: true,
        models: [{ id: "gpt-5.5" }],
        selectedModel: "gpt-5.5",
        detected: { apiFormat: "chat", stream: true },
      },
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(calls).toEqual([
      "/services/openai/secret",
      "/services/config",
    ]);
    expect(bodies).toEqual([
      { apiKey: "sk-live" },
      {
        service: "openai",
        defaultModel: "gpt-5.5",
        services: [
          { service: "openai", temperature: 0.7, apiFormat: "chat", stream: true, models: ["gpt-5.5"] },
        ],
      },
    ]);
    expect(result).toEqual({
      detectedModel: "gpt-5.5",
      detectedConfig: { apiFormat: "chat", stream: true },
      status: { state: "connected", models: [{ id: "gpt-5.5" }] },
    });
  });

  it("does not persist secrets/config when validation fails", async () => {
    const calls: string[] = [];
    const fetchJsonImpl = vi.fn(async (path: string, init?: { body?: string }) => {
      calls.push(path);
      if (path === "/services/openai/test") {
        expect(init?.body ? JSON.parse(init.body) : null).toEqual({
          apiKey: "sk-bad",
          apiFormat: "chat",
          stream: true,
        });
        return { ok: false, error: "invalid key" };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    await expect(saveServiceConfig({
      effectiveServiceId: "openai",
      serviceId: "openai",
      isCustom: false,
      resolvedCustomName: "",
      apiKey: "sk-bad",
      baseUrl: "",
      apiFormat: "chat",
      stream: true,
      temperature: "0.7",
      detectedModel: "",
      fetchJsonImpl: fetchJsonImpl as never,
    })).resolves.toEqual({
      detectedModel: "",
      detectedConfig: null,
      status: { state: "error", message: "invalid key" },
    });

    expect(calls).toEqual(["/services/openai/test"]);
  });

  it("allows local custom services to validate and save without an API key", async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const fetchJsonImpl = vi.fn(async (path: string, init?: { body?: string }) => {
      calls.push(path);
      if (init?.body) bodies.push(JSON.parse(init.body));
      if (path === "/services/custom%3ALocal/test") {
        return {
          ok: true,
          models: [{ id: "qwen3.6:35b-a3b" }],
          selectedModel: "qwen3.6:35b-a3b",
          detected: { apiFormat: "chat", stream: false, baseUrl: "http://127.0.0.1:8001/v1" },
        };
      }
      if (path === "/services/custom%3ALocal/secret") return { ok: true };
      if (path === "/services/config") return { ok: true };
      throw new Error(`unexpected path: ${path}`);
    });

    const result = await saveServiceConfig({
      effectiveServiceId: "custom:Local",
      serviceId: "custom",
      isCustom: true,
      resolvedCustomName: "Local",
      apiKey: "",
      baseUrl: "http://127.0.0.1:8001/v1",
      apiFormat: "chat",
      stream: false,
      temperature: "0.7",
      detectedModel: "",
      fetchJsonImpl: fetchJsonImpl as never,
    });

    // New custom service: config (with create intent) is accepted before the secret is written.
    expect(calls).toEqual([
      "/services/custom%3ALocal/test",
      "/services/config",
      "/services/custom%3ALocal/secret",
    ]);
    expect(bodies).toEqual([
      { apiKey: "", apiFormat: "chat", stream: false, baseUrl: "http://127.0.0.1:8001/v1" },
      {
        service: "custom:Local",
        intent: "create",
        defaultModel: "qwen3.6:35b-a3b",
        services: [
          {
            service: "custom",
            temperature: 0.7,
            apiFormat: "chat",
            stream: false,
            models: ["qwen3.6:35b-a3b"],
            name: "Local",
            baseUrl: "http://127.0.0.1:8001/v1",
          },
        ],
      },
      { apiKey: "" },
    ]);
    expect(result.status).toEqual({ state: "connected", models: [{ id: "qwen3.6:35b-a3b" }] });
  });
});

describe("deleteServiceConfig", () => {
  it("deletes a configured service through the service endpoint", async () => {
    const fetchJsonImpl = vi.fn(async () => ({ ok: true }));

    await deleteServiceConfig("custom:Local", { fetchJsonImpl: fetchJsonImpl as never });

    expect(fetchJsonImpl).toHaveBeenCalledWith("/services/custom%3ALocal", {
      method: "DELETE",
    });
  });
});

describe("resolveServiceDetailIdentity", () => {
  it("keeps the persisted identity separate from the edited name on rename", () => {
    expect(resolveServiceDetailIdentity("custom:B", " C ")).toEqual({
      isCustom: true,
      customName: "C",
      persistedServiceId: "custom:B",
      effectiveServiceId: "custom:C",
      previousServiceId: "custom:B",
    });
  });

  it("does not report a rename when the name is unchanged", () => {
    expect(resolveServiceDetailIdentity("custom:B", "B")).toEqual({
      isCustom: true,
      customName: "B",
      persistedServiceId: "custom:B",
      effectiveServiceId: "custom:B",
    });
  });

  it("treats the bare custom route as a new service with no persisted identity", () => {
    expect(resolveServiceDetailIdentity("custom", "C")).toEqual({
      isCustom: true,
      customName: "C",
      persistedServiceId: null,
      effectiveServiceId: "custom:C",
    });
  });

  it("falls back to the persisted identity while the name field is blank", () => {
    expect(resolveServiceDetailIdentity("custom:B", "   ")).toMatchObject({
      customName: "",
      persistedServiceId: "custom:B",
      effectiveServiceId: "custom:B",
    });
  });

  it("uses the route id for preset services", () => {
    expect(resolveServiceDetailIdentity("openai", "")).toEqual({
      isCustom: false,
      customName: "",
      persistedServiceId: "openai",
      effectiveServiceId: "openai",
    });
  });
});

describe("service detail configured vs discovered models", () => {
  const m = (id: string) => ({ id });

  it("never presents discovered/live models as configured", () => {
    const view = deriveServiceDetailModelView(
      [m("m1"), m("m3")],
      [m("m1"), m("m2"), m("m3")],
      [m("M2"), m("m4")],
    );
    expect(view.configured).toEqual([m("m1"), m("m3")]);
    expect(view.discovered).toEqual([m("m2"), m("m4")]);
  });

  it("removes a model from the configured list only, without promoting live models", () => {
    expect(removeServiceDetailModel([m("m1"), m("m2"), m("m3")], "M2")).toEqual([m("m1"), m("m3")]);
  });

  it("lets the first discovery seed an empty configured list", () => {
    expect(applyDiscoveredServiceDetailModels({
      configuredModels: [],
      hasConfiguredModelList: false,
      discoveredModels: [m("m1"), m("m2")],
    })).toEqual({ configuredModels: [m("m1"), m("m2")], hasConfiguredModelList: true });
  });

  it("does not let a re-probe overwrite an explicit configured list", () => {
    expect(applyDiscoveredServiceDetailModels({
      configuredModels: [m("m1"), m("m3")],
      hasConfiguredModelList: true,
      discoveredModels: [m("m1"), m("m2"), m("m3"), m("m4")],
    })).toEqual({ configuredModels: [m("m1"), m("m3")], hasConfiguredModelList: true });
  });
});

describe("saveServiceConfig — custom service lifecycle regression", () => {
  const probeB = {
    apiKey: "sk-b",
    baseUrl: "https://b.example/v1",
    apiFormat: "anthropic" as const,
    stream: false,
    models: [{ id: "b-1" }, { id: "b-2" }, { id: "b-3" }],
    selectedModel: "b-2",
    detected: { apiFormat: "anthropic" as const, stream: false, baseUrl: "https://b.example/v1" },
  };

  function recordingFetch(handlers: Record<string, (body: unknown) => unknown>) {
    const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
    const fetchJsonImpl = vi.fn(async (path: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      const handler = handlers[path];
      if (!handler) throw new Error(`unexpected path: ${path}`);
      return handler(body);
    });
    return { calls, fetchJsonImpl };
  }

  const baseArgs = {
    isCustom: true,
    apiKey: "sk-b",
    baseUrl: "https://b.example/v1",
    apiFormat: "anthropic" as const,
    stream: false,
    temperature: "0.9",
  };

  it("T3a: saving after deleting m2 persists exactly the configured list even when the reused probe still lists m2", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/custom%3AB/secret": () => ({ ok: true }),
      "/services/config": () => ({ ok: true }),
    });

    const result = await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom:B",
      effectiveServiceId: "custom:B",
      resolvedCustomName: "B",
      detectedModel: "b-2",
      configuredModels: [{ id: "b-1" }, { id: "b-3" }],
      verifiedProbe: probeB,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    const config = calls.find((call) => call.path === "/services/config")?.body as {
      defaultModel?: string;
      services: Array<{ models: string[] }>;
    };
    expect(config.services[0]?.models).toEqual(["b-1", "b-3"]);
    expect(config.defaultModel).toBe("b-1");
    expect(result.detectedModel).toBe("b-1");
    expect(result.status).toEqual({ state: "connected", models: [{ id: "b-1" }, { id: "b-3" }] });
  });

  it("T3b: saving after deleting m2 persists exactly the configured list when a fresh probe re-discovers m2", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/custom%3AB/test": () => ({
        ok: true,
        models: [{ id: "b-1" }, { id: "b-2" }, { id: "b-3" }, { id: "b-4" }],
        selectedModel: "b-2",
        detected: { apiFormat: "anthropic", stream: false, baseUrl: "https://b.example/v1" },
      }),
      "/services/custom%3AB/secret": () => ({ ok: true }),
      "/services/config": () => ({ ok: true }),
    });

    const result = await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom:B",
      effectiveServiceId: "custom:B",
      resolvedCustomName: "B",
      detectedModel: "b-2",
      configuredModels: [{ id: "b-1" }, { id: "b-3" }],
      verifiedProbe: null,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    const config = calls.find((call) => call.path === "/services/config")?.body as {
      defaultModel?: string;
      services: Array<{ models: string[] }>;
    };
    expect(config.services[0]?.models).toEqual(["b-1", "b-3"]);
    expect(config.defaultModel).toBe("b-1");
    expect(result.status).toEqual({ state: "connected", models: [{ id: "b-1" }, { id: "b-3" }] });
  });

  it("T3c: an explicitly emptied configured list is saved as empty and does not write a deleted default model", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/custom%3AB/secret": () => ({ ok: true }),
      "/services/config": () => ({ ok: true }),
    });

    await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom:B",
      effectiveServiceId: "custom:B",
      resolvedCustomName: "B",
      detectedModel: "b-2",
      configuredModels: [],
      verifiedProbe: probeB,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    const config = calls.find((call) => call.path === "/services/config")?.body as Record<string, unknown> & {
      services: Array<{ models: string[] }>;
    };
    expect(config.services[0]?.models).toEqual([]);
    expect(config).not.toHaveProperty("defaultModel");
  });

  it("T6: renaming persisted custom:B to C sends service=custom:C with previousService=custom:B, config before secret", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/config": () => ({ ok: true }),
      "/services/custom%3AC/secret": () => ({ ok: true }),
    });

    const result = await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom:B",
      effectiveServiceId: "custom:C",
      resolvedCustomName: "C",
      detectedModel: "b-1",
      configuredModels: [{ id: "b-1" }, { id: "b-2" }, { id: "b-3" }],
      verifiedProbe: probeB,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(result.status.state).toBe("connected");
    expect(calls.map((call) => call.path)).toEqual([
      "/services/config",
      "/services/custom%3AC/secret",
    ]);
    expect(calls[0]?.body).toMatchObject({
      service: "custom:C",
      previousService: "custom:B",
      services: [{ service: "custom", name: "C", baseUrl: "https://b.example/v1", models: ["b-1", "b-2", "b-3"] }],
    });
    expect(calls[0]?.body).not.toHaveProperty("intent");
    expect(calls[1]?.body).toEqual({ apiKey: "sk-b" });
  });

  it("T2/T6: a plain edit of persisted custom:B carries no rename or create marker", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/custom%3AB/secret": () => ({ ok: true }),
      "/services/config": () => ({ ok: true }),
    });

    await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom:B",
      effectiveServiceId: "custom:B",
      resolvedCustomName: "B",
      detectedModel: "b-1",
      configuredModels: [{ id: "b-1" }],
      verifiedProbe: probeB,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    const config = calls.find((call) => call.path === "/services/config")?.body;
    expect(config).toMatchObject({ service: "custom:B" });
    expect(config).not.toHaveProperty("previousService");
    expect(config).not.toHaveProperty("intent");
  });

  it("T1/I9: adding a new custom service sends a create intent and never a previousService", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/config": () => ({ ok: true }),
      "/services/custom%3AC/secret": () => ({ ok: true }),
    });

    await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom",
      effectiveServiceId: "custom:C",
      resolvedCustomName: "C",
      apiKey: "sk-c",
      detectedModel: "",
      verifiedProbe: { ...probeB, apiKey: "sk-c" },
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(calls.map((call) => call.path)).toEqual([
      "/services/config",
      "/services/custom%3AC/secret",
    ]);
    expect(calls[0]?.body).toMatchObject({ service: "custom:C", intent: "create" });
    expect(calls[0]?.body).not.toHaveProperty("previousService");
  });

  it("T7: a rejected duplicate create does not overwrite the existing service secret", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/config": () => { throw new Error("Custom service “B” already exists"); },
      "/services/custom%3AB/secret": () => ({ ok: true }),
    });

    const result = await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom",
      effectiveServiceId: "custom:B",
      resolvedCustomName: "B",
      apiKey: "sk-impostor",
      detectedModel: "",
      verifiedProbe: { ...probeB, apiKey: "sk-impostor" },
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(result.status).toEqual({ state: "error", message: "Custom service “B” already exists" });
    expect(calls.map((call) => call.path)).toEqual(["/services/config"]);
  });

  it("T7: a rejected rename onto an existing name leaves both secrets untouched", async () => {
    const { calls, fetchJsonImpl } = recordingFetch({
      "/services/config": () => { throw new Error("Custom service “A” already exists"); },
    });

    const result = await saveServiceConfig({
      ...baseArgs,
      serviceId: "custom:B",
      effectiveServiceId: "custom:A",
      resolvedCustomName: "A",
      detectedModel: "",
      verifiedProbe: probeB,
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(result.status.state).toBe("error");
    expect(calls.map((call) => call.path)).toEqual(["/services/config"]);
  });

  it.each([
    ["new service", "custom", "custom", "   "],
    ["rename to blank", "custom:B", "custom:B", ""],
  ])("T7: rejects a blank custom service name before any request (%s)", async (_label, serviceId, effectiveServiceId, name) => {
    const fetchJsonImpl = vi.fn(async () => ({ ok: true }));

    const result = await saveServiceConfig({
      ...baseArgs,
      serviceId,
      effectiveServiceId,
      resolvedCustomName: name,
      detectedModel: "",
      fetchJsonImpl: fetchJsonImpl as never,
    });

    expect(result.status).toEqual({ state: "error", message: "请先填写服务名称" });
    expect(fetchJsonImpl).not.toHaveBeenCalled();
  });
});

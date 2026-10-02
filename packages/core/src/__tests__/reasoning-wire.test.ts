import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLLMClient, chatCompletion, LLMConfigSchema } from "../index.js";
import { composeReasoningOnPayload } from "../llm/reasoning-effort.js";
import type { ReasoningEffort } from "../llm/reasoning-effort.js";

// ============================================================
// Phase 2: pi-ai 0.67.1 边界 + 真实 wire payload 验证。
//
// 用真实 pi-ai adapters（不 mock @mariozechner/pi-ai），把请求打到本地
// 捕获服务器，检查最终序列化的 request body：
// - low/medium/high/xhigh 保留 pi-ai 的实际 reasoning 行为（含映射）。
// - none/max 由 InkOS transformer 原值写入，不被删除/降级/转换。
// - 旧 onPayload callback：原地修改保留、返回新对象生效、异步 await、
//   抛错直接传播且不发请求；只有 undefined 表示"未替换"。
// ============================================================

interface CapturedRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

let server: http.Server;
let baseUrl = "";
let requests: CapturedRequest[] = [];

const chatChunk = (delta: Record<string, unknown>, extra?: Record<string, unknown>) =>
  JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });

const CHAT_SSE = [
  `data: ${chatChunk({ content: "ok" })}`,
  `data: ${chatChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
  "data: [DONE]",
  "",
].join("\n\n");

const responsesEvent = (data: Record<string, unknown>) =>
  `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}`;

const RESPONSES_SSE = [
  responsesEvent({ type: "response.created", response: { id: "resp_1" } }),
  responsesEvent({ type: "response.output_item.added", output_index: 0, item: { id: "i1", type: "message", role: "assistant", status: "in_progress", content: [] } }),
  responsesEvent({ type: "response.content_part.added", item_id: "i1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }),
  responsesEvent({ type: "response.output_text.delta", item_id: "i1", output_index: 0, content_index: 0, delta: "ok" }),
  responsesEvent({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
  "",
].join("\n\n");

const anthropicEvent = (data: Record<string, unknown>) =>
  `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}`;

const ANTHROPIC_SSE = [
  anthropicEvent({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
  anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
  anthropicEvent({ type: "content_block_stop", index: 0 }),
  anthropicEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  anthropicEvent({ type: "message_stop" }),
  "",
].join("\n\n");

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
      requests.push({ path: req.url ?? "", body });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const sse = (req.url ?? "").includes("/responses")
        ? RESPONSES_SSE
        : (req.url ?? "").includes("/messages")
          ? ANTHROPIC_SSE
          : CHAT_SSE;
      res.end(sse);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

function lastBody(): Record<string, unknown> {
  expect(requests.length).toBeGreaterThan(0);
  return requests[requests.length - 1]!.body;
}

function chatClient(model: string) {
  return createLLMClient(LLMConfigSchema.parse({
    provider: "openai",
    service: "openai",
    apiFormat: "chat",
    apiFormatExplicit: true,
    baseUrl,
    apiKey: "test-key",
    model,
    thinkingBudget: 8192,
    stream: true,
  }));
}

function responsesClient(model: string, thinkingBudget = 8192) {
  return createLLMClient(LLMConfigSchema.parse({
    provider: "openai",
    service: "openai",
    apiFormat: "responses",
    apiFormatExplicit: true,
    baseUrl,
    apiKey: "test-key",
    model,
    thinkingBudget,
    stream: true,
  }));
}

function anthropicClient(model: string, thinkingBudget = 8192) {
  return createLLMClient(LLMConfigSchema.parse({
    provider: "anthropic",
    service: "anthropic",
    apiFormat: "anthropic",
    apiFormatExplicit: true,
    baseUrl,
    apiKey: "test-key",
    model,
    thinkingBudget,
    stream: true,
  }));
}

async function run(client: ReturnType<typeof createLLMClient>, options?: Record<string, unknown>) {
  // 用 client 实际持有的 model id 调用：resolvePiModel 会用第二个参数覆盖
  // piModel.id，而 pi-ai 的 supportsXhigh / supportsAdaptiveThinking 都基于
  // model.id 判断，传错名字会走错分支。
  return chatCompletion(client, client._piModel!.id, [{ role: "user", content: "hi" }], options as never);
}

// ============================================================
// Chat（openai-completions）
// ============================================================

describe("wire: openai-completions reasoning_effort", () => {
  it.each(["low", "medium", "high"] as const)("keeps pi-ai behavior for %s", async (level) => {
    await run(chatClient("wire-chat"), { reasoningEffort: level });
    expect(lastBody().reasoning_effort).toBe(level);
  });

  it("keeps pi-ai xhigh mapping: preserved on xhigh-capable model ids", async () => {
    await run(chatClient("gpt-5.4-wire"), { reasoningEffort: "xhigh" });
    expect(lastBody().reasoning_effort).toBe("xhigh");
  });

  it("keeps pi-ai xhigh mapping: clamped to high on non-xhigh model ids", async () => {
    await run(chatClient("wire-chat-xhigh"), { reasoningEffort: "xhigh" });
    expect(lastBody().reasoning_effort).toBe("high");
  });

  it("writes none verbatim without passing it to pi-ai", async () => {
    await run(chatClient("wire-chat"), { reasoningEffort: "none" });
    expect(lastBody().reasoning_effort).toBe("none");
  });

  it("writes max verbatim without passing it to pi-ai", async () => {
    await run(chatClient("wire-chat"), { reasoningEffort: "max" });
    expect(lastBody().reasoning_effort).toBe("max");
  });

  it("never emits none/max as a pi-ai simple reasoning option (chat has no reasoning field to leak)", async () => {
    await run(chatClient("wire-chat"), { reasoningEffort: "max" });
    // pi-ai chat adapter only writes reasoning_effort from options.reasoningEffort;
    // if InkOS had passed reasoning:"max" as a simple option the value would also
    // appear, so prove bypass via a controlled field the adapter would not write.
    expect(lastBody().reasoning).toBeUndefined();
  });
});

// ============================================================
// Responses（openai-responses）
// ============================================================

describe("wire: openai-responses reasoning.effort", () => {
  it.each(["low", "medium", "high"] as const)("keeps pi-ai behavior for %s", async (level) => {
    await run(responsesClient("gpt-5.4-wire"), { reasoningEffort: level });
    const body = lastBody();
    expect((body.reasoning as Record<string, unknown>).effort).toBe(level);
    expect((body.reasoning as Record<string, unknown>).summary).toBe("auto");
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("keeps pi-ai xhigh on xhigh-capable model ids", async () => {
    await run(responsesClient("gpt-5.4-wire"), { reasoningEffort: "xhigh" });
    expect((lastBody().reasoning as Record<string, unknown>).effort).toBe("xhigh");
  });

  it("writes none verbatim over the pi-ai default", async () => {
    await run(responsesClient("gpt-5.4-wire"), { reasoningEffort: "none" });
    expect((lastBody().reasoning as Record<string, unknown>).effort).toBe("none");
  });

  it("writes max verbatim over the pi-ai default (pi-ai would have written effort:none)", async () => {
    await run(responsesClient("gpt-5.4-wire"), { reasoningEffort: "max" });
    expect((lastBody().reasoning as Record<string, unknown>).effort).toBe("max");
  });

  it("still writes max verbatim when model.reasoning is false (pi-ai wrote no reasoning at all)", async () => {
    await run(responsesClient("wire-chat", 0), { reasoningEffort: "max" });
    const body = lastBody();
    expect((body.reasoning as Record<string, unknown>).effort).toBe("max");
    expect(body.include).toBeUndefined();
  });
});

// ============================================================
// Anthropic（anthropic-messages）
// ============================================================

describe("wire: anthropic-messages thinking/output_config", () => {
  it.each(["low", "medium", "high"] as const)("adaptive model keeps pi-ai effort mapping for %s", async (level) => {
    await run(anthropicClient("claude-sonnet-4-6-wire"), { reasoningEffort: level });
    const body = lastBody();
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect((body.output_config as Record<string, unknown>).effort).toBe(level);
  });

  it("adaptive opus-4-6 keeps pi-ai xhigh mapping to effort max", async () => {
    await run(anthropicClient("claude-opus-4-6-wire"), { reasoningEffort: "xhigh" });
    expect((lastBody().output_config as Record<string, unknown>).effort).toBe("max");
  });

  it("adaptive sonnet-4-6 keeps pi-ai xhigh mapping to effort high", async () => {
    await run(anthropicClient("claude-sonnet-4-6-wire"), { reasoningEffort: "xhigh" });
    expect((lastBody().output_config as Record<string, unknown>).effort).toBe("high");
  });

  it("does not pass max to pi-ai: sonnet-4-6 gets verbatim max, not pi-ai's fallback high", async () => {
    // If InkOS passed reasoning:"max" to pi-ai, mapThinkingLevelToEffort would
    // fall through to "high". The final payload must carry the raw value.
    await run(anthropicClient("claude-sonnet-4-6-wire"), { reasoningEffort: "max" });
    expect((lastBody().output_config as Record<string, unknown>).effort).toBe("max");
  });

  it("does not pass none to pi-ai: verbatim none without forcing adaptive thinking on", async () => {
    await run(anthropicClient("claude-sonnet-4-6-wire"), { reasoningEffort: "none" });
    const body = lastBody();
    expect((body.output_config as Record<string, unknown>).effort).toBe("none");
    // InkOS must not force adaptive thinking on or off: pi-ai saw no reasoning
    // option, so thinking stays disabled exactly as pi-ai decided.
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it.each(["low", "medium", "high"] as const)("budget model keeps pi-ai budget_tokens for %s", async (level) => {
    await run(anthropicClient("claude-3-7-sonnet-wire"), { reasoningEffort: level });
    const body = lastBody();
    expect((body.thinking as Record<string, unknown>).type).toBe("enabled");
    expect(typeof (body.thinking as Record<string, unknown>).budget_tokens).toBe("number");
    expect(body.output_config).toBeUndefined();
  });

  it("budget model: max is written verbatim to output_config without touching pi-ai thinking", async () => {
    await run(anthropicClient("claude-3-7-sonnet-wire"), { reasoningEffort: "max" });
    const body = lastBody();
    expect((body.output_config as Record<string, unknown>).effort).toBe("max");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("model.reasoning=false: max still lands verbatim in output_config", async () => {
    await run(anthropicClient("claude-sonnet-4-6-wire", 0), { reasoningEffort: "max" });
    const body = lastBody();
    expect((body.output_config as Record<string, unknown>).effort).toBe("max");
    expect(body.thinking).toBeUndefined();
  });
});

// ============================================================
// 旧 onPayload callback 组合语义
// ============================================================

describe("wire: legacy onPayload composition", () => {
  it("preserves in-place mutations from the legacy callback", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await run(chatClient("wire-chat"), {
      reasoningEffort: "max",
      onPayload: (payload: Record<string, unknown>) => {
        seen.push(payload);
        payload.top_p = 0.5; // in-place, returns undefined
      },
    });
    expect(seen).toHaveLength(1);
    expect(lastBody().top_p).toBe(0.5);
    expect(lastBody().reasoning_effort).toBe("max");
  });

  it("uses the returned replacement object and still applies InkOS effort", async () => {
    await run(chatClient("wire-chat"), {
      reasoningEffort: "max",
      onPayload: (payload: Record<string, unknown>) => ({ ...payload, seed: 7, temperature: 0.33 }),
    });
    const body = lastBody();
    expect(body.seed).toBe(7);
    expect(body.temperature).toBe(0.33); // replacement wins over pi-ai's 0.7
    expect(body.reasoning_effort).toBe("max");
  });

  it("awaits async legacy callbacks", async () => {
    await run(chatClient("wire-chat"), {
      reasoningEffort: "none",
      onPayload: async (payload: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, 10));
        return { ...payload, user_field: "async" };
      },
    });
    expect(lastBody().user_field).toBe("async");
    expect(lastBody().reasoning_effort).toBe("none");
  });

  it("propagates callback errors and never sends the request", async () => {
    const before = requests.length;
    await expect(run(chatClient("wire-chat"), {
      reasoningEffort: "max",
      onPayload: () => {
        throw new Error("callback-boom");
      },
      retry: false,
    })).rejects.toThrow("callback-boom");
    expect(requests.length).toBe(before);
  });

  it("does not treat falsy non-undefined returns as keep-original: fails loudly instead", async () => {
    // truthiness 判断会把 false 静默当作 "未替换"；InkOS 只认 undefined，
    // 非对象替换值会明确抛错而不是悄悄发原始 payload。
    const original = { model: "m", reasoning_effort: "low" };
    const composed = composeReasoningOnPayload("chat", "max", () => false as unknown as Record<string, unknown>);
    await expect(composed(original, {})).rejects.toThrow(/plain object/);
  });

  it("keeps unrelated-field mutations while InkOS overrides the controlled reasoning field", async () => {
    await run(chatClient("wire-chat"), {
      reasoningEffort: "max",
      onPayload: (payload: Record<string, unknown>) => {
        payload.temperature = 0.11;           // unrelated field: keep
        payload.reasoning_effort = "low";     // controlled field: InkOS wins
      },
    });
    const body = lastBody();
    expect(body.temperature).toBe(0.11);
    expect(body.reasoning_effort).toBe("max");
  });

  it.each(["low", "medium", "high", "xhigh"] as const)("preserves legacy callback policy conflicts for pi-ai-owned %s instead of rewriting the raw stop", async (effort) => {
    await run(chatClient("gpt-5.4-wire"), {
      reasoningEffort: effort,
      onPayload: (payload: Record<string, unknown>) => {
        payload.reasoning_effort = "legacy-policy";
        payload.seed = 17;
      },
    });
    expect(lastBody()).toMatchObject({ reasoning_effort: "legacy-policy", seed: 17 });
  });

  it("keeps unrelated fields on responses payloads too", async () => {
    await run(responsesClient("gpt-5.4-wire"), {
      reasoningEffort: "max",
      onPayload: (payload: Record<string, unknown>) => {
        (payload.reasoning as Record<string, unknown>).summary = "concise";
        payload.store = true;
      },
    });
    const body = lastBody();
    expect(body.store).toBe(true);
    expect(body.reasoning).toEqual({ effort: "max", summary: "concise" });
  });

  it("keeps anthropic output_config conflicts overridden by InkOS", async () => {
    await run(anthropicClient("claude-sonnet-4-6-wire"), {
      reasoningEffort: "max",
      onPayload: (payload: Record<string, unknown>) => {
        payload.output_config = { effort: "low", format: { type: "text" } };
      },
    });
    expect(lastBody().output_config).toEqual({ effort: "max", format: { type: "text" } });
  });

  it("still honors the legacy callback when no effort is configured", async () => {
    await run(chatClient("wire-chat"), {
      onPayload: (payload: Record<string, unknown>) => ({ ...payload, seed: 42 }),
    });
    expect(lastBody().seed).toBe(42);
    expect(lastBody().reasoning_effort).toBeUndefined();
  });
});

// Type-level guard: six states only.
const ALL_EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
it("six-state surface is unchanged", () => {
  expect(ALL_EFFORTS).toHaveLength(6);
});

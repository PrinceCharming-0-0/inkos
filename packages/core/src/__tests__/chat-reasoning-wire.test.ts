import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getApiProvider, registerApiProvider, type Api, type Model } from "@mariozechner/pi-ai";
import { runAgentSession, evictAgentCache, abortAgentSession, type AgentSessionConfig } from "../agent/agent-session.js";
import { guardedPiStream } from "../agent/pi-stream.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../llm/reasoning-effort.js";

// Real Agent, guardedPiStream, pi-ai adapters and SDKs. Only the upstream is local.
const event = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const responsesSse = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", item: { id: "i1", type: "message", role: "assistant", content: [] } },
  { type: "response.content_part.added", part: { type: "output_text", text: "", annotations: [] } },
  { type: "response.output_text.delta", delta: "ok" },
  { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } },
].map(event).join("");
const anthropicSse = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(event).join("");
function chatSse(tool: boolean) {
  const delta = tool
    ? { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "book-a/story/story_bible.md" }) } }] }
    : { content: "ok" };
  const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  return chunk(delta, null) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n";
}

let root: string;
let server: http.Server;
let baseUrl: string;
let bodies: Record<string, any>[];
let pending: Array<() => void>;
let hold: boolean;
let reject: boolean;
const ids = new Set<string>();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "inkos-chat-effort-"));
  await mkdir(join(root, "books/book-a/story"), { recursive: true });
  await writeFile(join(root, "books/book-a/story/story_bible.md"), "test truth");
  bodies = []; pending = []; hold = false; reject = false;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const send = () => {
        if (reject) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unsupported reasoning effort", type: "invalid_request_error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const last = body.messages?.at(-1);
        const tool = last?.role === "user" && JSON.stringify(last.content).includes("use tool");
        res.end(req.url?.includes("/responses") ? responsesSse : req.url?.includes("/messages") ? anthropicSse : chatSse(tool));
      };
      if (hold) pending.push(send); else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  hold = false;
  pending.splice(0).forEach((send) => send());
  ids.forEach(evictAgentCache); ids.clear();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});
function model(api: Api = "openai-completions"): Model<Api> {
  return {
    api, id: api === "anthropic-messages" ? "claude-opus-4-6" : "gpt-5.4",
    provider: api === "anthropic-messages" ? "anthropic" : "openai", name: "wire", baseUrl,
    reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000, maxTokens: 8192,
  };
}
function config(id: string, effort?: ReasoningEffort, api?: Api): AgentSessionConfig {
  ids.add(id);
  return { sessionId: id, bookId: null, language: "en", pipeline: {} as never, projectRoot: root, model: model(api), apiKey: "test-key", reasoningEffort: effort };
}
async function waitForRequests(count: number) {
  // A server event, not polling: install a listener before any async request arrives.
  if (bodies.length >= count) return;
  await new Promise<void>((resolve) => {
    const listener = (req: http.IncomingMessage) => {
      req.on("end", () => {
        if (bodies.length >= count) { server.off("request", listener); resolve(); }
      });
    };
    server.on("request", listener);
  });
}

describe("Chat Agent real wire reasoning", () => {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    it.each(REASONING_EFFORTS)(`${api} serializes %s through the actual Chat stream entry`, async (effort) => {
      const result = await runAgentSession(config("matrix", effort, api), "hello");
      expect(result.errorMessage).toBeUndefined();
      expect(result.responseText).toBe("ok");
      expect(bodies).toHaveLength(1);
      const body = bodies[0]!;
      const expected = api === "anthropic-messages" && effort === "xhigh" ? "max" : effort;
      expect(api === "openai-completions" ? body.reasoning_effort : api === "openai-responses" ? body.reasoning.effort : body.output_config.effort).toBe(expected);
      if (api === "anthropic-messages") expect(body.thinking.type).toBe(effort === "none" || effort === "max" ? "disabled" : "adaptive");
    });
  }

  it("keeps pi-ai xhigh clamping for a model without native xhigh support", async () => {
    const turn = config("clamped", "xhigh");
    turn.model = { ...model(), id: "wire-ordinary-model" };
    const result = await runAgentSession(turn, "hello");
    expect(result.errorMessage).toBeUndefined();
    expect(bodies[0]!.reasoning_effort).toBe("high");
  });

  it("preserves Anthropic budget and non-reasoning branches", async () => {
    const budget = config("budget", "medium", "anthropic-messages");
    budget.model = { ...model("anthropic-messages"), id: "claude-3-7-sonnet", maxTokens: 24576 };
    await runAgentSession(budget, "hello");
    expect(bodies[0]!.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(bodies[0]!.output_config).toBeUndefined();
    const disabled = config("nonreasoning", "max", "anthropic-messages");
    disabled.model = { ...model("anthropic-messages"), reasoning: false };
    await runAgentSession(disabled, "hello");
    expect(bodies[1]!.thinking).toBeUndefined();
    expect(bodies[1]!.output_config.effort).toBe("max");
  });

  it("cancellation clears generation context before a subsequent legacy request", async () => {
    hold = true;
    const running = runAgentSession(config("cancel", "max"), "hello");
    await waitForRequests(1);
    expect(abortAgentSession(root, "cancel")).toBe(true);
    const cancelled = await running;
    expect(cancelled.errorMessage).toBeDefined();
    hold = false;
    pending.splice(0).forEach((send) => send());
    const next = await runAgentSession(config("cancel"), "next");
    expect(next.errorMessage).toBeUndefined();
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["max", undefined]);
  });

  it("cached Agent retains history and changes effort each round without cache eviction or residual context", async () => {
    const first = await runAgentSession(config("cached", "low"), "first");
    const second = await runAgentSession(config("cached", "max"), "second");
    const third = await runAgentSession(config("cached"), "third");
    expect([first.errorMessage, second.errorMessage, third.errorMessage]).toEqual([undefined, undefined, undefined]);
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["low", "max", undefined]);
    expect(second.messages).toHaveLength(4);
    expect(third.messages).toHaveLength(6);
    expect(JSON.stringify(bodies[1]!.messages)).toContain("first");
  });

  it("snapshots before queue await, isolates queued rounds and concurrent sessions", async () => {
    hold = true;
    const a = config("a", "low");
    const running = runAgentSession(a, "first");
    await waitForRequests(1);
    const queuedConfig = config("a", "max");
    const queued = runAgentSession(queuedConfig, "second");
    queuedConfig.reasoningEffort = "none";
    a.reasoningEffort = "high";
    hold = false;
    const parallel = await runAgentSession(config("b", "medium"), "other session");
    expect(parallel.errorMessage).toBeUndefined();
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["low", "medium"]);
    pending.splice(0).forEach((send) => send());
    await Promise.all([running, queued]);
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["low", "medium", "max"]);
    expect(JSON.stringify(bodies[2]!.messages)).toContain("first");
  });

  it("all model calls after a tool result retain the same round snapshot", async () => {
    const turn = config("multi", "max");
    turn.bookId = "book-a";
    const result = await runAgentSession(turn, "use tool", undefined);
    expect(result.errorMessage).toBeUndefined();
    expect(result.responseText).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.reasoning_effort)).toEqual(["max", "max"]);
    expect(result.messages.some((message) => message.role === "toolResult")).toBe(true);
    // Existing Chat compatibility transform folds OpenAI tool results into user text.
    expect(JSON.stringify(bodies[1]!.messages)).toContain("[Tool results]");
    expect(JSON.stringify(bodies[1]!.messages)).toContain("test truth");
  });

  it("preserves a legacy async onPayload through guardedPiStream with InkOS applied last", async () => {
    const options = { apiKey: "test-key", reasoning: "high" as const, onPayload: async (payload: unknown) => {
      await Promise.resolve();
      const body = payload as Record<string, unknown>;
      body.seed = 7;
      body.reasoning_effort = "low";
      return { ...body, temperature: 0.21 };
    } };
    const stream = guardedPiStream(model(), { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, options, "max");
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(bodies[0]).toMatchObject({ seed: 7, temperature: 0.21, reasoning_effort: "max" });
    expect(options.reasoning).toBe("high");
  });

  it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)("%s converts callback failure to an error event recognized by the Agent application without issuing HTTP", async (api) => {
    const original = getApiProvider(api)!;
    const events: any[] = [];
    // Instrument only the payload callback; delegate to the real registered
    // adapter after guardedPiStream has composed the reasoning boundary.
    registerApiProvider({
      ...original,
      streamSimple: (streamModel, context, options) => original.streamSimple(streamModel, context, {
        ...options,
        onPayload: async (payload, callbackModel) => {
          await options?.onPayload?.(payload, callbackModel);
          throw new Error("legacy-callback-boom");
        },
      }),
    });
    try {
      const result = await runAgentSession({ ...config("callback-error", "max", api), onEvent: (event) => { events.push(event); } }, "hello");
      expect(result.responseText).toBe("");
      expect(result.errorMessage).toContain("legacy-callback-boom");
      expect(events.some((event) => event.type === "message_end" && event.message.stopReason === "error")).toBe(true);
      expect(bodies).toHaveLength(0);
    } finally {
      registerApiProvider(original);
    }
    const next = await runAgentSession(config("callback-error", undefined, api), "next");
    expect(next.errorMessage).toBeUndefined();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.reasoning_effort).toBeUndefined();
    expect(bodies[0]!.output_config).toBeUndefined();
    expect(bodies[0]!.reasoning?.effort).toBe(api === "openai-responses" ? "none" : undefined);
  });

  it("malformed legacy replacement produces an adapter error event and zero provider requests", async () => {
    const stream = guardedPiStream(model(), { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, {
      apiKey: "test-key", onPayload: () => false,
    }, "none");
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("payload must be a plain object");
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(bodies).toHaveLength(0);
  });

  it("surfaces provider rejection without downgrade/re-send, and a subsequent legacy turn has no residual effort", async () => {
    reject = true;
    const result = await runAgentSession(config("error", "max"), "hello");
    expect(result.errorMessage).toContain("unsupported reasoning effort");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.reasoning_effort).toBe("max");
    reject = false;
    const next = await runAgentSession(config("error"), "next");
    expect(next.errorMessage).toBeUndefined();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.reasoning_effort).toBeUndefined();
  });
});

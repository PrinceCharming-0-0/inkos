import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectConfigSchema, REASONING_EFFORTS, createAndPersistBookSession,
  evictAgentCache, type ApiFormat, type ReasoningEffort,
} from "@actalk/inkos-core";
import { createStudioServer } from "./server.js";

// No Agent, stream, resolver, adapter or reasoning-boundary mocks. The only
// substitute is an HTTP upstream with fake credentials and deterministic SSE.
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
const chatSse = [
  { delta: { content: "ok" }, finish_reason: null },
  { delta: {}, finish_reason: "stop" },
].map((choice) => `data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, ...choice }] })}\n\n`).join("") + "data: [DONE]\n\n";

let root: string;
let server: http.Server;
let baseUrl: string;
let requests: Array<{ path: string; body: Record<string, any> }>;
let reject: boolean;
beforeEach(async () => {
  vi.stubEnv("INKOS_AGENT_LLM_STUB", undefined);
  root = await mkdtemp(join(tmpdir(), "inkos-agent-route-effort-"));
  requests = []; reject = false;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ path: req.url!, body: JSON.parse(raw) });
      if (reject) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unsupported reasoning effort", type: "invalid_request_error" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(req.url?.includes("/responses") ? responsesSse : req.url?.includes("/messages") ? anthropicSse : chatSse);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Built-in services intentionally resolve their preset host. Redirect only
  // the transport to localhost, preserving URL path, headers and serialized
  // body. This also prevents fake credentials from reaching a real endpoint.
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    return realFetch(new Request(`${baseUrl}${url.pathname}${url.search}`, request));
  });
});
afterEach(async () => {
  evictAgentCache("route-effort");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup(apiFormat: ApiFormat, model?: string, service = "custom:Wire") {
  const modelId = model ?? (apiFormat === "anthropic" ? "claude-opus-4-6" : "gpt-5.4");
  const config = ProjectConfigSchema.parse({
    name: "wire-test", version: "0.1.0", language: "en",
    llm: { provider: "openai", baseUrl, service: "minimax", model: modelId, configSource: "studio", defaultModel: modelId,
      services: [{ service: service === "custom:Wire" ? "custom" : service, ...(service === "custom:Wire" ? { name: "Wire" } : {}), models: [modelId], apiFormat, baseUrl }] },
  });
  await writeFile(join(root, "inkos.json"), JSON.stringify(config));
  await mkdir(join(root, ".inkos"), { recursive: true });
  await writeFile(join(root, ".inkos/secrets.json"), JSON.stringify({ services: { [service]: { apiKey: "test-key" } } }));
  await createAndPersistBookSession(root, null, "route-effort", "chat");
  const app = createStudioServer(config, root);
  return (reasoningEffort?: ReasoningEffort) => app.request("http://localhost/api/v1/agent", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction: "hello", sessionId: "route-effort", service, model: modelId, reasoningEffort }),
  });
}

function effortOf(format: ApiFormat, body: Record<string, any>) {
  return format === "chat" ? body.reasoning_effort : format === "responses" ? body.reasoning?.effort : body.output_config?.effort;
}

describe("/agent → runAgentSession → guardedPiStream → pi-ai → serialized HTTP body", () => {
  for (const format of ["chat", "responses", "anthropic"] as const) {
    it.each(REASONING_EFFORTS)(`${format}: %s reaches the authoritative protocol field`, async (effort) => {
      const send = await setup(format);
      const response = await send(effort);
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result).toMatchObject({ response: "ok" });
      expect(requests).toHaveLength(1);
      const { path, body } = requests[0]!;
      expect(path).toBe(format === "chat" ? "/chat/completions" : format === "responses" ? "/responses" : "/v1/messages");
      expect(effortOf(format, body)).toBe(format === "anthropic" && effort === "xhigh" ? "max" : effort);
      if (format === "anthropic") expect(body.thinking).toEqual({ type: effort === "none" || effort === "max" ? "disabled" : "adaptive" });
      if (format !== "chat") expect(body.reasoning_effort).toBeUndefined();
      if (format !== "responses") expect(body.reasoning).toBeUndefined();
      if (format !== "anthropic") expect(body.output_config).toBeUndefined();
    });

    it(`${format}: legacy caller retains pi-ai defaults`, async () => {
      const send = await setup(format);
      const response = await send();
      expect(response.status).toBe(200);
      expect(requests).toHaveLength(1);
      expect(effortOf(format, requests[0]!.body)).toBe(format === "responses" ? "none" : undefined);
      if (format === "anthropic") expect(requests[0]!.body.thinking).toEqual({ type: "disabled" });
    });

    it.each(["none", "max"] as const)(`${format}: provider rejection of %s returns to the app without downgrade or re-send`, async (effort) => {
      const send = await setup(format);
      reject = true;
      const response = await send(effort);
      expect(response.status).toBe(500);
      const result = await response.json();
      expect(result.error.message).toContain("unsupported reasoning effort");
      expect(result.response).toContain("unsupported reasoning effort");
      expect(requests).toHaveLength(1);
      expect(effortOf(format, requests[0]!.body)).toBe(effort);
    });
  }

  for (const format of ["chat", "responses", "anthropic"] as const) {
    it.each(["none", "max"] as const)(`${format}: explicit format overrides MiniMax's chat preset on the real wire for %s`, async (effort) => {
      const send = await setup(format, undefined, "minimax");
      const response = await send(effort);
      expect(response.status, JSON.stringify(await response.json())).toBe(200);
      expect(requests).toHaveLength(1);
      expect(effortOf(format, requests[0]!.body)).toBe(effort);
      // Preset host includes /v1; the actual adapter appends its own route.
      expect(requests[0]!.path).toBe(format === "chat" ? "/v1/chat/completions" : format === "responses" ? "/v1/responses" : "/v1/v1/messages");
    });
  }

  it("preserves pi-ai's omission of four-level effort on a non-reasoning model", async () => {
    const send = await setup("chat", "ordinary-model");
    expect((await send("xhigh")).status).toBe(200);
    // Resolver marks an unknown model non-reasoning, so pi-ai omits effort.
    expect(requests[0]!.body.reasoning_effort).toBeUndefined();
  });
});

// packages/core/src/__tests__/reasoning-effort.test.ts
import { describe, it, expect } from "vitest";
import {
  REASONING_EFFORTS,
  normalizeReasoningEffort,
  applyReasoningEffortToPayload,
  type ReasoningEffort,
} from "../llm/reasoning-effort.js";

describe("ReasoningEffort six-state type", () => {
  it("exposes exactly the fixed six states", () => {
    expect([...REASONING_EFFORTS]).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("normalizes every valid state to itself", () => {
    for (const state of REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(state)).toBe(state);
    }
  });

  it("rejects pi-ai-only and foreign values", () => {
    // `minimal` exists in pi-ai 0.67.1's ThinkingLevel but is NOT an InkOS state.
    expect(normalizeReasoningEffort("minimal")).toBeUndefined();
    expect(normalizeReasoningEffort("default")).toBeUndefined();
    expect(normalizeReasoningEffort("off")).toBeUndefined();
    expect(normalizeReasoningEffort("maximum")).toBeUndefined();
    expect(normalizeReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeReasoningEffort(3)).toBeUndefined();
  });

  it("does not accept pi-ai's minimal in the InkOS union at compile time", () => {
    // Type-level guard: a non-InkOS string must not be assignable to ReasoningEffort.
    // (Runtime already covered above; this documents the closed union.)
    const exhaustive = (e: ReasoningEffort): ReasoningEffort => e;
    expect(exhaustive("none")).toBe("none");
  });
});

describe("applyReasoningEffortToPayload — chat (openai-completions)", () => {
  it("writes none verbatim into payload.reasoning_effort", () => {
    const out = applyReasoningEffortToPayload(
      { model: "gpt-5.4", messages: [{ role: "user" }] },
      "chat",
      "none",
    );
    expect(out.reasoning_effort).toBe("none");
    expect(out.model).toBe("gpt-5.4");
  });

  it("writes max verbatim into payload.reasoning_effort", () => {
    const out = applyReasoningEffortToPayload({ model: "gpt-5.4" }, "chat", "max");
    expect(out.reasoning_effort).toBe("max");
  });

  it("preserves unrelated siblings and does not mutate input", () => {
    const messages = Object.freeze([{ role: "user", content: "hi" }]);
    const tools = Object.freeze([{ type: "function" }]);
    const payload = Object.freeze({ model: "x", messages, tools, metadata: { traceId: "t1" } });

    const out = applyReasoningEffortToPayload(payload, "chat", "none");

    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(out).not.toBe(payload);
    expect(out.messages).toBe(messages);
    expect(out.tools).toBe(tools);
    expect(out.metadata).toBe(payload.metadata);
    expect(out.model).toBe("x");
  });
});

describe("applyReasoningEffortToPayload — responses (openai-responses)", () => {
  it("writes none into payload.reasoning.effort", () => {
    const out = applyReasoningEffortToPayload({ model: "x" }, "responses", "none");
    expect(out.reasoning).toEqual({ effort: "none" });
  });

  it("writes max into payload.reasoning.effort", () => {
    const out = applyReasoningEffortToPayload({ model: "x" }, "responses", "max");
    expect(out.reasoning).toEqual({ effort: "max" });
  });

  it("preserves reasoning.summary and other reasoning siblings", () => {
    const payload = Object.freeze({
      model: "x",
      reasoning: Object.freeze({ effort: "low", summary: Object.freeze({ text: "sum" }), extra: "keep" }),
    });

    const out = applyReasoningEffortToPayload(payload, "responses", "max");

    expect(out.reasoning).toEqual({ effort: "max", summary: { text: "sum" }, extra: "keep" });
    const outReasoning = out.reasoning as { summary: { text: string }; effort: string };
    expect(outReasoning.summary).toBe(payload.reasoning.summary);
    expect(payload.reasoning.effort).toBe("low");
  });

  it("only copies the modified levels (structural sharing)", () => {
    const messages = Object.freeze([{ role: "user" }]);
    const payload = Object.freeze({ model: "x", messages, reasoning: Object.freeze({ effort: "low" }) });

    const out = applyReasoningEffortToPayload(payload, "responses", "none");

    expect(out).not.toBe(payload);
    expect(out.reasoning).not.toBe(payload.reasoning);
    expect(out.messages).toBe(messages);
  });
});

describe("applyReasoningEffortToPayload — anthropic (anthropic-messages)", () => {
  it("writes none into payload.output_config.effort", () => {
    const out = applyReasoningEffortToPayload({ model: "x" }, "anthropic", "none");
    expect(out.output_config).toEqual({ effort: "none" });
  });

  it("writes max into payload.output_config.effort", () => {
    const out = applyReasoningEffortToPayload({ model: "x" }, "anthropic", "max");
    expect(out.output_config).toEqual({ effort: "max" });
  });

  it("preserves output_config.format and other siblings", () => {
    const payload = Object.freeze({
      model: "x",
      output_config: Object.freeze({ format: "text", effort: "high" }),
    });

    const out = applyReasoningEffortToPayload(payload, "anthropic", "max");

    expect(out.output_config).toEqual({ format: "text", effort: "max" });
    expect(payload.output_config.effort).toBe("high");
  });
});

describe("applyReasoningEffortToPayload — pi-ai-owned levels", () => {
  it("passes low/medium/high/xhigh through unchanged (pi-ai owns their payload)", () => {
    const payload = Object.freeze({ model: "x", reasoning: { effort: "low" } });
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      expect(applyReasoningEffortToPayload(payload, "responses", level)).toBe(payload);
    }
  });
});

describe("applyReasoningEffortToPayload — errors and idempotency", () => {
  it("throws on an illegal apiFormat", () => {
    expect(() => applyReasoningEffortToPayload({}, "openai-completions" as never, "none"))
      .toThrow(/apiFormat/i);
  });

  it("throws on an invalid effort value", () => {
    expect(() => applyReasoningEffortToPayload({}, "chat", "default" as never)).toThrow(/effort/i);
  });

  it("throws on a non-object payload", () => {
    expect(() => applyReasoningEffortToPayload(null, "chat", "none")).toThrow(/payload/i);
    expect(() => applyReasoningEffortToPayload([], "chat", "none")).toThrow(/payload/i);
    expect(() => applyReasoningEffortToPayload("nope", "chat", "none")).toThrow(/payload/i);
  });

  it("throws on an unexpected reasoning shape for responses", () => {
    expect(() => applyReasoningEffortToPayload({ reasoning: "oops" }, "responses", "none"))
      .toThrow(/reasoning/i);
    expect(() => applyReasoningEffortToPayload({ reasoning: null }, "responses", "none"))
      .toThrow(/reasoning/i);
  });

  it("throws on an unexpected output_config shape for anthropic", () => {
    expect(() => applyReasoningEffortToPayload({ output_config: [] }, "anthropic", "max"))
      .toThrow(/output_config/i);
  });

  it("throws on an unexpected reasoning_effort shape for chat", () => {
    expect(() => applyReasoningEffortToPayload({ reasoning_effort: { effort: "x" } }, "chat", "none"))
      .toThrow(/reasoning_effort/i);
  });

  it("is idempotent for the same patch (deep-equal and reference-stable)", () => {
    const payload = Object.freeze({ model: "x", output_config: Object.freeze({ format: "text" }) });
    const once = applyReasoningEffortToPayload(payload, "anthropic", "none");
    const twice = applyReasoningEffortToPayload(once, "anthropic", "none");
    expect(twice).toBe(once);
    expect(twice).toEqual({ model: "x", output_config: { format: "text", effort: "none" } });
  });
});

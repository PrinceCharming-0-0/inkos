import type { SimpleStreamOptions } from "@mariozechner/pi-ai";
import { API_FORMATS, type ApiFormat } from "../models/project.js";

/**
 * InkOS 的六态 reasoning effort。这是 InkOS 自己的产品态，
 * 固定为 none | low | medium | high | xhigh | max，不允许 default / minimal。
 *
 * - low / medium / high / xhigh 与 pi-ai 0.67.1 的 ThinkingLevel 一一对应，
 *   具体 payload 由 pi-ai 负责（options.reasoning / options.reasoningEffort）。
 * - none / max 是 InkOS 的扩展值，不属于 pi-ai ThinkingLevel，不能静默转换成
 *   其他档位，必须在最终 payload 里按 apiFormat 写入原值。
 */
export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return REASONING_EFFORTS.find((state) => state === value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return normalizeReasoningEffort(value) !== undefined;
}

function isApiFormat(value: unknown): value is ApiFormat {
  return API_FORMATS.includes(value as ApiFormat);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function assertPayloadObject(payload: unknown): asserts payload is Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(
      `reasoning-effort: payload must be a plain object, got ${describeValue(payload)}`,
    );
  }
}

/**
 * 不可变的 reasoning payload transformer。
 *
 * - 不修改输入 payload；只复制被修改的对象层级（structural sharing）。
 * - 不读取 model name / provider name / 环境变量 / 全局状态。
 * - low / medium / high / xhigh 由 pi-ai 负责，这里原样透传（返回原引用），
 *   不模拟、不重新映射。
 * - none / max 按 apiFormat 写入原值：
 *     chat       → payload.reasoning_effort
 *     responses  → payload.reasoning.effort
 *     anthropic  → payload.output_config.effort
 * - 对非法 apiFormat、非法 effort、不符合预期的 payload 形状抛出明确错误。
 * - 相同 patch 重复应用结果一致（值相等时返回原引用，保证引用稳定）。
 */
export function applyReasoningEffortToPayload(
  payload: unknown,
  apiFormat: ApiFormat,
  effort: ReasoningEffort,
): Record<string, unknown> {
  if (!isApiFormat(apiFormat)) {
    throw new Error(
      `reasoning-effort: illegal apiFormat ${JSON.stringify(apiFormat)}; ` +
      `expected one of ${API_FORMATS.join(" | ")}`,
    );
  }
  if (!isReasoningEffort(effort)) {
    throw new Error(
      `reasoning-effort: invalid effort ${JSON.stringify(effort)}; ` +
      `expected one of ${REASONING_EFFORTS.join(" | ")}`,
    );
  }
  assertPayloadObject(payload);

  if (effort !== "none" && effort !== "max") {
    return payload;
  }

  switch (apiFormat) {
    case "chat": {
      const existing = payload.reasoning_effort;
      if (existing !== undefined && typeof existing !== "string") {
        throw new Error(
          `reasoning-effort: chat payload.reasoning_effort must be a string, got ${describeValue(existing)}`,
        );
      }
      if (existing === effort) return payload;
      return { ...payload, reasoning_effort: effort };
    }
    case "responses": {
      const existing = payload.reasoning;
      if (existing === undefined) {
        return { ...payload, reasoning: { effort } };
      }
      if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(
          `reasoning-effort: responses payload.reasoning must be an object, got ${describeValue(existing)}`,
        );
      }
      const reasoning = existing as Record<string, unknown>;
      if (reasoning.effort === effort) return payload;
      return { ...payload, reasoning: { ...reasoning, effort } };
    }
    case "anthropic": {
      const existing = payload.output_config;
      if (existing === undefined) {
        return { ...payload, output_config: { effort } };
      }
      if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
        throw new Error(
          `reasoning-effort: anthropic payload.output_config must be an object, got ${describeValue(existing)}`,
        );
      }
      const outputConfig = existing as Record<string, unknown>;
      if (outputConfig.effort === effort) return payload;
      return { ...payload, output_config: { ...outputConfig, effort } };
    }
  }
}

export type ReasoningPayloadCallback = (
  payload: unknown,
  model: unknown,
) => unknown | undefined | Promise<unknown | undefined>;

/**
 * 组合 InkOS reasoning transformer 与旧 onPayload callback。
 *
 * 顺序（与 pi-ai adapter 的 onPayload 调用点对齐）：
 * 1. pi-ai adapter 构造 payload 后调用本回调；
 * 2. apiFormat/effort 策略在组合时已快照进闭包；
 * 3. await 旧 callback（同步/异步一视同仁）；
 * 4. 旧 callback 返回非 undefined 对象 → 以返回值为准（替换生效）；
 * 5. 返回 undefined → 保留原对象（含原地修改）；
 * 6. 最后执行 InkOS transformer（仅 none/max 会改写字段，
 *    low/medium/high/xhigh 原样透传）；
 * 7. 返回结果交给 pi-ai 发送。
 *
 * - 只用 `=== undefined` 判断“未替换”，绝不用 truthiness；
 * - 旧 callback 抛错直接向上传播，不发送请求。
 */
export function composeReasoningOnPayload(
  apiFormat: ApiFormat,
  effort: ReasoningEffort,
  legacy?: ReasoningPayloadCallback,
): ReasoningPayloadCallback {
  return async (payload, model) => {
    const returned = await legacy?.(payload, model);
    const base = returned === undefined ? payload : returned;
    return applyReasoningEffortToPayload(base, apiFormat, effort);
  };
}

/** Shared simple-options boundary for provider calls and Chat's guarded stream.
 * Snapshots primitives/callback, never mutates options or passes none/max to pi-ai.
 */
export function withReasoningEffort(
  options: SimpleStreamOptions | undefined,
  apiFormat: ApiFormat,
  effort: ReasoningEffort | undefined,
): SimpleStreamOptions | undefined {
  if (effort === undefined) return options;
  if (!isReasoningEffort(effort)) throw new Error(`reasoning-effort: invalid effort ${JSON.stringify(effort)}`);
  const legacy = options?.onPayload;
  return {
    ...options,
    reasoning: effort === "none" || effort === "max" ? undefined : effort,
    onPayload: composeReasoningOnPayload(apiFormat, effort,
      legacy ? (payload, model) => legacy(payload, model as Parameters<typeof legacy>[1]) : undefined),
  };
}

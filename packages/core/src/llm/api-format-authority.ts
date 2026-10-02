import type { ApiFormat } from "../models/project.js";

/** Invert the resolved protocol identity, never infer from names or endpoints. */
export function piApiToApiFormat(api: string): ApiFormat {
  switch (api) {
    case "openai-completions": return "chat";
    case "openai-responses": return "responses";
    case "anthropic-messages": return "anthropic";
    default: throw new Error(`reasoning-effort: unsupported resolved API ${api}`);
  }
}

/**
 * InkOS apiFormat（产品态）→ pi-ai API identity 的单一映射。
 * chat | responses | anthropic 是 InkOS 的三种传输协议。
 */
export function apiFormatToPiApi(format: ApiFormat): "openai-completions" | "openai-responses" | "anthropic-messages" {
  switch (format) {
    case "chat":
      return "openai-completions";
    case "responses":
      return "openai-responses";
    case "anthropic":
      return "anthropic-messages";
  }
}

/**
 * 统一的 apiFormat authority rule，resolveServiceModel 和 createLLMClient.resolvePiApi
 * 都必须遵守这一条规则：
 *
 * 1. 用户显式配置的 apiFormat 优先（custom 服务始终以传入的 apiFormat 为准，
 *    缺省等价于 chat）。
 * 2. 未显式配置时才使用 preset / endpoint 的 api。
 * 3. 两者都没有时回退到 legacy 默认 openai-completions。
 *
 * 规范化过程中自动补出的 apiFormat 不得被当成用户显式选择 —— 调用方必须通过
 * `explicitApiFormat === undefined` 来表达"未显式配置"，而不是传入一个补出来的默认值。
 */
export function resolveApiFormatAuthority(params: {
  readonly isCustom: boolean;
  readonly explicitApiFormat?: ApiFormat;
  readonly presetApi?: string;
}): string {
  if (params.isCustom) {
    return apiFormatToPiApi(params.explicitApiFormat ?? "chat");
  }
  if (params.explicitApiFormat !== undefined) {
    return apiFormatToPiApi(params.explicitApiFormat);
  }
  return params.presetApi ?? "openai-completions";
}

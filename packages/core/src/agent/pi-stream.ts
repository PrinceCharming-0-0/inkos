import { withReasoningEffort, type ReasoningEffort } from "../llm/reasoning-effort.js";
import { piApiToApiFormat } from "../llm/api-format-authority.js";
import { streamSimple } from "@mariozechner/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import {
  assertWithinContextWindow,
  estimatePiContextTokens,
  guardAssistantMessageStream,
} from "../llm/provider.js";
import {
  agentTrajectoryHeaders,
  beginAgentModelCall,
} from "../llm/agent-trajectory.js";

/**
 * The single Pi transport boundary used by both conversational and worker
 * agents. Pi keeps native tool calls; InkOS adds context guards, trajectory
 * headers, cancellation, and stream deadlines around the request.
 */
export function guardedPiStream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
  reasoningEffort?: ReasoningEffort,
): AssistantMessageEventStream {
  // Only Chat supplies the optional snapshot; workers remain unchanged.
  const streamOptions = reasoningEffort === undefined ? options
    : withReasoningEffort(options, piApiToApiFormat(model.api), reasoningEffort);
  const reservedOutputTokens = Number.isFinite(options?.maxTokens)
    ? options!.maxTokens!
    : Number.isFinite(model.maxTokens)
      ? model.maxTokens
      : 4096;
  assertWithinContextWindow({
    piModel: model,
    model: model.id,
    estimatedInputTokens: estimatePiContextTokens(context),
    reservedOutputTokens,
  });
  const modelCall = beginAgentModelCall();
  const traceHeaders = agentTrajectoryHeaders(model.baseUrl, modelCall, 1, {
    effort: String(reasoningEffort ?? options?.reasoning ?? (model.reasoning ? "enabled" : "disabled")),
  });
  return guardAssistantMessageStream(
    model,
    (signal) => streamSimple(model, context, {
      ...streamOptions,
      headers: { ...(streamOptions?.headers ?? {}), ...traceHeaders },
      signal,
    }),
    options?.signal,
  );
}

import type { ReasoningEffort } from "@actalk/inkos-core";

/**
 * Six slider stops, index 0..5. Mirrors core REASONING_EFFORTS (asserted in
 * tests); duplicated here because the browser bundle cannot import core's
 * runtime entry. There is deliberately no seventh / hidden state.
 */
export const REASONING_EFFORT_STEPS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies ReadonlyArray<ReasoningEffort>;

export const REASONING_EFFORT_MIN_INDEX = 0;
export const REASONING_EFFORT_MAX_INDEX = REASONING_EFFORT_STEPS.length - 1;
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

const LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function reasoningEffortLabel(effort: ReasoningEffort): string {
  return LABELS[effort];
}

export function reasoningEffortToIndex(effort: ReasoningEffort): number {
  const index = REASONING_EFFORT_STEPS.indexOf(effort);
  return index === -1 ? REASONING_EFFORT_STEPS.indexOf(DEFAULT_REASONING_EFFORT) : index;
}

/** Maps a raw range value back to an effort; non-integral or out-of-range input yields null. */
export function reasoningEffortFromIndex(raw: number | string): ReasoningEffort | null {
  const index = typeof raw === "number" ? raw : raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isInteger(index)) return null;
  return REASONING_EFFORT_STEPS[index] ?? null;
}

/**
 * Keyboard contract: ArrowLeft/ArrowRight move one stop (clamped),
 * Home → None, End → Max. Other keys return null and keep native behavior.
 */
export function reasoningEffortForKey(current: ReasoningEffort, key: string): ReasoningEffort | null {
  const index = reasoningEffortToIndex(current);
  switch (key) {
    case "ArrowLeft":
      return REASONING_EFFORT_STEPS[Math.max(REASONING_EFFORT_MIN_INDEX, index - 1)];
    case "ArrowRight":
      return REASONING_EFFORT_STEPS[Math.min(REASONING_EFFORT_MAX_INDEX, index + 1)];
    case "Home":
      return REASONING_EFFORT_STEPS[REASONING_EFFORT_MIN_INDEX];
    case "End":
      return REASONING_EFFORT_STEPS[REASONING_EFFORT_MAX_INDEX];
    default:
      return null;
  }
}

import { useId, type KeyboardEvent } from "react";
import type { ReasoningEffort } from "@actalk/inkos-core";
import {
  REASONING_EFFORT_MAX_INDEX,
  REASONING_EFFORT_MIN_INDEX,
  reasoningEffortForKey,
  reasoningEffortFromIndex,
  reasoningEffortLabel,
  reasoningEffortToIndex,
} from "./reasoning-effort-control";

/**
 * Six-stop native range for the session's reasoning effort. Fully controlled
 * by the store value and free of effects: it only writes on user input, and
 * only when the stop actually changes, so dragging can never feed back into
 * a render loop.
 */
export function ReasoningEffortControl({
  value,
  onChange,
  disabled,
  isZh,
  className,
}: {
  readonly value: ReasoningEffort;
  readonly onChange: (effort: ReasoningEffort) => void;
  readonly disabled?: boolean;
  readonly isZh: boolean;
  readonly className?: string;
}) {
  const inputId = useId();
  const label = reasoningEffortLabel(value);
  const commit = (next: ReasoningEffort | null) => {
    if (next && next !== value) onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const next = reasoningEffortForKey(value, event.key);
    if (!next) return;
    // Own the documented keys so behavior doesn't depend on browser/RTL defaults.
    event.preventDefault();
    commit(next);
  };

  return (
    <div
      data-testid="reasoning-effort-control"
      className={`flex min-w-0 items-center gap-2 ${className ?? ""}`}
    >
      <label
        htmlFor={inputId}
        className="shrink-0 whitespace-nowrap text-[13px] text-muted-foreground"
      >
        {isZh ? "推理强度" : "Effort"}
      </label>
      <input
        id={inputId}
        type="range"
        min={REASONING_EFFORT_MIN_INDEX}
        max={REASONING_EFFORT_MAX_INDEX}
        step={1}
        value={reasoningEffortToIndex(value)}
        aria-valuetext={label}
        disabled={disabled}
        onChange={(event) => commit(reasoningEffortFromIndex(event.currentTarget.value))}
        onKeyDown={onKeyDown}
        className="h-1.5 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
      />
      <output
        htmlFor={inputId}
        data-testid="reasoning-effort-value"
        className="w-[4.5rem] shrink-0 whitespace-nowrap text-left text-[13px] font-medium tabular-nums"
      >
        {label}
      </output>
    </div>
  );
}

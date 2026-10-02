import { useId, type CSSProperties, type KeyboardEvent } from "react";
import type { ReasoningEffort } from "@actalk/inkos-core";
import {
  REASONING_EFFORT_STEPS,
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
  const index = reasoningEffortToIndex(value);
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
      className={`reasoning-effort min-w-0 ${className ?? ""}`}
      style={{ "--effort-progress": `${(index / REASONING_EFFORT_MAX_INDEX) * 100}%` } as CSSProperties}
    >
      <label
        htmlFor={inputId}
        className="reasoning-effort-label"
      >
        {isZh ? "思考强度" : "Effort"}<span aria-hidden="true">{isZh ? "：" : ":"}</span>
      </label>
      <output
        htmlFor={inputId}
        data-testid="reasoning-effort-value"
        className="reasoning-effort-value"
      >
        {label}
      </output>
      <div className="reasoning-effort-slider">
        <div className="reasoning-effort-track" aria-hidden="true">
          <div className="reasoning-effort-fill" />
          {REASONING_EFFORT_STEPS.map((effort, stop) => (
            <span
              key={effort}
              className="reasoning-effort-node"
              data-selected={stop <= index}
              style={{ left: `${(stop / REASONING_EFFORT_MAX_INDEX) * 100}%` }}
            />
          ))}
        </div>
        <input
          id={inputId}
          type="range"
          min={REASONING_EFFORT_MIN_INDEX}
          max={REASONING_EFFORT_MAX_INDEX}
          step={1}
          value={index}
          aria-valuetext={label}
          disabled={disabled}
          onChange={(event) => commit(reasoningEffortFromIndex(event.currentTarget.value))}
          onKeyDown={onKeyDown}
          className="reasoning-effort-input"
        />
      </div>
    </div>
  );
}

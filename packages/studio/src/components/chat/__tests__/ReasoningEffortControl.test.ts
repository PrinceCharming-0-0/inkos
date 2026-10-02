import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { REASONING_EFFORTS } from "@actalk/inkos-core";
import { ReasoningEffortControl } from "../ReasoningEffortControl";
import {
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORT_STEPS,
  reasoningEffortForKey,
  reasoningEffortFromIndex,
  reasoningEffortLabel,
  reasoningEffortToIndex,
} from "../reasoning-effort-control";

const LABELS = ["None", "Low", "Medium", "High", "XHigh", "Max"];

function render(value: (typeof REASONING_EFFORT_STEPS)[number], extra: { disabled?: boolean; isZh?: boolean } = {}) {
  return renderToStaticMarkup(
    React.createElement(ReasoningEffortControl, { value, onChange: () => {}, isZh: false, ...extra }),
  );
}

describe("reasoning effort steps", () => {
  it("has exactly the six core states, in order, with no hidden seventh stop", () => {
    expect([...REASONING_EFFORT_STEPS]).toEqual([...REASONING_EFFORTS]);
    expect(REASONING_EFFORT_STEPS.map(reasoningEffortLabel)).toEqual(LABELS);
    expect(reasoningEffortFromIndex(6)).toBeNull();
    expect(reasoningEffortFromIndex(-1)).toBeNull();
    expect(reasoningEffortFromIndex(2.5)).toBeNull();
    expect(reasoningEffortFromIndex("")).toBeNull();
  });

  it("defaults to Medium and round-trips every stop through the range index", () => {
    expect(DEFAULT_REASONING_EFFORT).toBe("medium");
    REASONING_EFFORT_STEPS.forEach((effort, index) => {
      expect(reasoningEffortToIndex(effort)).toBe(index);
      expect(reasoningEffortFromIndex(index)).toBe(effort);
      expect(reasoningEffortFromIndex(String(index))).toBe(effort);
    });
  });

  it("moves one stop with ArrowLeft/ArrowRight and clamps at the ends", () => {
    expect(reasoningEffortForKey("medium", "ArrowLeft")).toBe("low");
    expect(reasoningEffortForKey("medium", "ArrowRight")).toBe("high");
    expect(reasoningEffortForKey("none", "ArrowLeft")).toBe("none");
    expect(reasoningEffortForKey("max", "ArrowRight")).toBe("max");
  });

  it("jumps to None on Home and Max on End; other keys stay native", () => {
    expect(reasoningEffortForKey("high", "Home")).toBe("none");
    expect(reasoningEffortForKey("low", "End")).toBe("max");
    expect(reasoningEffortForKey("low", "Tab")).toBeNull();
    expect(reasoningEffortForKey("low", "ArrowUp")).toBeNull();
  });
});

describe("ReasoningEffortControl", () => {
  it("renders a native 0..5 step-1 range showing the current stop", () => {
    const html = render("medium");
    expect(html).toContain('type="range"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="5"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="2"');
    expect(html).toContain('aria-valuetext="Medium"');
    expect(html).toMatch(/<output[^>]*>Medium<\/output>/);
  });

  it.each(REASONING_EFFORT_STEPS.map((effort, index) => [effort, index, LABELS[index]] as const))(
    "renders %s as index %i with aria-valuetext %s",
    (effort, index, label) => {
      const html = render(effort);
      expect(html).toContain(`value="${index}"`);
      expect(html).toContain(`aria-valuetext="${label}"`);
      expect(html).toMatch(new RegExp(`<output[^>]*>${label}</output>`));
    },
  );

  it("labels the range for assistive tech and honors disabled", () => {
    const html = render("max", { disabled: true, isZh: true });
    const inputId = html.match(/<input[^>]*id="([^"]+)"/)?.[1];
    expect(inputId).toBeTruthy();
    expect(html).toContain(`for="${inputId}"`);
    expect(html).toContain("推理强度");
    expect(html).toMatch(/<input[^>]*disabled=""/);
  });
});

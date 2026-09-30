import { describe, expect, it } from "vitest";
import {
  buildConfiguredModelGroups,
  resolveSelectionSync,
  type ChatPageServiceInfo,
} from "./chat-page-state";

/**
 * Runtime-style regression tests for the ChatPage model selection effect.
 *
 * The repo has no component-mount test infrastructure (no jsdom / happy-dom /
 * @testing-library), so the effect body is exercised through its extracted
 * transition helper `resolveSelectionSync`, replayed exactly as React would:
 * render -> effect -> store write -> render -> effect ... until the effect
 * emits a no-op. A healthy sync must terminate with bounded writes; the
 * 3b1ab658 implementation looped forever (React error #185, maximum update
 * depth exceeded) whenever the current selection was already valid.
 *
 * NOTE: real component mount is not covered by automation here (see above);
 * manual browser verification is still required.
 */

const services: ChatPageServiceInfo[] = [
  { service: "custom:A", label: "A", connected: true },
  { service: "custom:B", label: "B", connected: true },
];

const configuredServices = [
  { service: "custom", name: "A", models: ["a1", "a2"] },
  { service: "custom", name: "B", models: ["b1", "b2"] },
];

const persistedDefault = { service: "custom:B", model: "b2" };

function replayMountCycle(): { writes: number; model: string | null; service: string | null } {
  const groupedModels = buildConfiguredModelGroups({ services, configuredServices });
  let model: string | null = null;
  let service: string | null = null;
  let writes = 0;

  // Simulate: mount with empty selection (init), then every store update
  // re-triggers the effect. A stable sync must emit a no-op and stop.
  for (let round = 0; round < 100; round += 1) {
    const sync = resolveSelectionSync(groupedModels, model, service, persistedDefault);
    if (sync.kind === "noop") break;
    writes += 1;
    model = sync.model;
    service = sync.service;
  }

  return { writes, model, service };
}

describe("chat selection sync (runtime-style effect replay)", () => {
  it("mount cycle terminates with bounded setter calls", () => {
    const result = replayMountCycle();

    expect(result.writes).toBeLessThanOrEqual(2);
    expect(result).toMatchObject({ model: "b2", service: "custom:B" });
  });

  it("a valid current pair is a no-op (zero state writes)", () => {
    const groupedModels = buildConfiguredModelGroups({ services, configuredServices });

    expect(resolveSelectionSync(groupedModels, "b2", "custom:B", persistedDefault)).toEqual({ kind: "noop" });
    expect(resolveSelectionSync(groupedModels, "a1", "custom:A", persistedDefault)).toEqual({ kind: "noop" });
    expect(resolveSelectionSync(groupedModels, "b2", "custom:B", null)).toEqual({ kind: "noop" });
  });

  it("a deleted model falls back once and then stays put", () => {
    const groupedWithoutB2 = buildConfiguredModelGroups({
      services,
      configuredServices: [
        { service: "custom", name: "A", models: ["a1", "a2"] },
        { service: "custom", name: "B", models: ["b1"] },
      ],
    });

    const first = resolveSelectionSync(groupedWithoutB2, "b2", "custom:B", null);
    expect(first).toEqual({ kind: "set", model: "b1", service: "custom:B" });

    // After the write, the new pair is valid: the next effect run is a no-op.
    expect(resolveSelectionSync(groupedWithoutB2, "b1", "custom:B", null)).toEqual({ kind: "noop" });
  });

  it("a service with no configured models clears the stale pair, then converges without toggling", () => {
    const groupedEmptyB = buildConfiguredModelGroups({
      services,
      configuredServices: [
        { service: "custom", name: "A", models: ["a1"] },
        { service: "custom", name: "B", models: [] },
      ],
    });

    const first = resolveSelectionSync(groupedEmptyB, "b2", "custom:B", null);
    expect(first).toEqual({ kind: "set", model: null, service: null });

    // Null state falls back to the first configured group (designed fallback),
    // then the new valid pair stays put: bounded writes, no toggle loop.
    const second = resolveSelectionSync(groupedEmptyB, null, null, null);
    expect(second).toEqual({ kind: "set", model: "a1", service: "custom:A" });
    expect(resolveSelectionSync(groupedEmptyB, "a1", "custom:A", null)).toEqual({ kind: "noop" });
  });

  it("null state with no configured groups at all stays null without toggling", () => {
    const empty = buildConfiguredModelGroups({
      services,
      configuredServices: [
        { service: "custom", name: "A", models: [] },
        { service: "custom", name: "B", models: [] },
      ],
    });

    expect(resolveSelectionSync(empty, null, null, null)).toEqual({ kind: "noop" });
    expect(resolveSelectionSync(empty, "a1", "custom:A", null)).toEqual({ kind: "set", model: null, service: null });
  });
});

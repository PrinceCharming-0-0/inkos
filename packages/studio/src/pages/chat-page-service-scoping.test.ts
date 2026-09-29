import { describe, expect, it } from "vitest";
import {
  buildConfiguredModelGroups,
  pickModelSelection,
} from "./chat-page-state";

describe("chat model picker — service-scoped configured models", () => {
  // NOTE: the pre-fix bug (live/discovered catalogs and other services' models
  // leaking into the picker; stale models surviving service switches) was
  // proven RED against the old live-catalog grouping before the fix; the
  // obsolete mirror of that grouping has been removed and the fixed behavior
  // is covered below.
  const services = [
    { service: "custom:FARO API", label: "FARO API", connected: true },
    { service: "custom:Zephyr", label: "Zephyr", connected: true },
  ];

  describe("buildConfiguredModelGroups — configured models only", () => {
    const configuredServices = [
      { service: "custom", name: "FARO API", models: ["a1", "a2"] },
      { service: "custom", name: "Zephyr", models: ["b1", "b2"] },
    ];

    it("T1: scopes picker options to the selected service's configured models", () => {
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices,
        activeService: "custom:FARO API",
      });
      expect(groups).toEqual([
        {
          service: "custom:FARO API",
          label: "FARO API",
          models: [
            { id: "a1", name: "a1" },
            { id: "a2", name: "a2" },
          ],
        },
      ]);
      const optionIds = groups.flatMap((group) => group.models.map((model) => model.id));
      expect(optionIds).not.toContain("b1");
      expect(optionIds).not.toContain("b2");
    });

    it("T2: after a service switch, options recompute and the stale model falls back inside the new service", () => {
      const zephyrGroups = buildConfiguredModelGroups({
        services,
        configuredServices,
        activeService: "custom:Zephyr",
      });
      expect(zephyrGroups.flatMap((group) => group.models.map((model) => model.id)))
        .toEqual(["b1", "b2"]);

      const next = pickModelSelection(zephyrGroups, "a2", "custom:FARO API", {
        service: "custom:Zephyr",
        model: "retired-model",
      });
      expect(next).not.toBeNull();
      expect(next!.model).not.toBe("a2");
      expect(next).toEqual({ model: "b1", service: "custom:Zephyr" });
    });

    it("T3: a deleted configured model disappears from the picker after config refresh", () => {
      const afterDelete = [
        { service: "custom", name: "FARO API", models: ["a1", "a3"] },
        configuredServices[1]!,
      ];
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices: afterDelete,
        activeService: "custom:FARO API",
      });
      const optionIds = groups.flatMap((group) => group.models.map((model) => model.id));
      expect(optionIds).toEqual(["a1", "a3"]);
      expect(optionIds).not.toContain("a2");
    });

    it("T4: deleting the currently-selected model falls back to a valid model of the same service", () => {
      const afterDelete = [
        { service: "custom", name: "FARO API", models: ["a1", "a3"] },
        configuredServices[1]!,
      ];
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices: afterDelete,
        activeService: "custom:FARO API",
      });
      const next = pickModelSelection(groups, "a2", "custom:FARO API", {
        service: "custom:FARO API",
        model: "a2",
      });
      expect(next).toEqual({ model: "a1", service: "custom:FARO API" });
    });

    it("T5: updating an unrelated service's configured models does not touch the selected service's options", () => {
      const before = buildConfiguredModelGroups({
        services,
        configuredServices,
        activeService: "custom:FARO API",
      });
      const afterZephyrChange = buildConfiguredModelGroups({
        services,
        configuredServices: [
          configuredServices[0]!,
          { service: "custom", name: "Zephyr", models: ["b1", "b2", "b9-turbo"] },
        ],
        activeService: "custom:FARO API",
      });
      expect(afterZephyrChange).toEqual(before);
    });

    it("T6: live/discovered models never mix into the configured picker options", () => {
      // The helper takes no live catalog input at all; even with the upstream
      // probe advertising a1/a2/a3, only the configured a1 is offered.
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices: [
          { service: "custom", name: "FARO API", models: ["a1"] },
          configuredServices[1]!,
        ],
        activeService: "custom:FARO API",
      });
      expect(groups).toEqual([
        {
          service: "custom:FARO API",
          label: "FARO API",
          models: [{ id: "a1", name: "a1" }],
        },
      ]);
    });

    it("T6b: a configured entry without a model list contributes no group", () => {
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices: [
          { service: "custom", name: "FARO API", models: [] },
          { service: "custom", name: "Zephyr" },
        ],
        activeService: "custom:FARO API",
      });
      expect(groups).toEqual([]);
    });

    it("C7: a renamed custom service keeps its configured models under the new identity", () => {
      const renamed = [
        { service: "custom", name: "C", models: ["b1", "b2"] },
        configuredServices[0]!,
      ];
      const renamedServices = [
        { service: "custom:C", label: "C", connected: true },
        { service: "custom:FARO API", label: "FARO API", connected: true },
      ];
      const groups = buildConfiguredModelGroups({
        services: renamedServices,
        configuredServices: renamed,
        activeService: "custom:C",
      });
      expect(groups.flatMap((group) => group.models.map((model) => model.id)))
        .toEqual(["b1", "b2"]);
      // The old identity is gone; it must not resurrect the old catalog.
      expect(buildConfiguredModelGroups({
        services: renamedServices,
        configuredServices: renamed,
        activeService: "custom:Zephyr",
      })).toEqual([]);
    });

    it("T7: a stale cross-service model never survives as the selection", () => {
      const faroGroups = buildConfiguredModelGroups({
        services,
        configuredServices,
        activeService: "custom:FARO API",
      });
      // b1 belongs to Zephyr only; with FARO selected it must fall back to a
      // valid FARO model before any request is built.
      const next = pickModelSelection(faroGroups, "b1", "custom:FARO API", null);
      expect(next).toEqual({ model: "a1", service: "custom:FARO API" });
    });

    it("falls back to the first connected service that has configured models when none is selected", () => {
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices,
        activeService: null,
      });
      expect(groups.map((group) => group.service)).toEqual(["custom:FARO API"]);
    });

    it("returns no groups for a disconnected or unknown selected service", () => {
      expect(buildConfiguredModelGroups({
        services,
        configuredServices,
        activeService: "custom:Ghost",
      })).toEqual([]);
      expect(buildConfiguredModelGroups({
        services: [services[0]!, { ...services[1]!, connected: false }],
        configuredServices,
        activeService: "custom:Zephyr",
      })).toEqual([]);
    });

    it("deduplicates configured model ids case-insensitively and preserves order", () => {
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices: [
          { service: "custom", name: "FARO API", models: ["a1", "A1", "a2", " a1 "] },
        ],
        activeService: "custom:FARO API",
      });
      expect(groups[0]!.models.map((model) => model.id)).toEqual(["a1", "a2"]);
    });
  });
});

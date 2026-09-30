import { describe, expect, it } from "vitest";
import {
  buildConfiguredModelGroups,
  pickModelSelection,
} from "./chat-page-state";

const services = [
  { service: "custom:A", label: "A", connected: true },
  { service: "custom:B", label: "B", connected: true },
  { service: "custom:C", label: "C", connected: true },
];

const configuredServices = [
  { service: "custom", name: "A", models: ["a1", "a2"] },
  { service: "custom", name: "B", models: ["b1", "b2"] },
  { service: "custom", name: "C", models: ["c1"] },
];

function modelIds(groups: ReadonlyArray<{ models: ReadonlyArray<{ id: string }> }>): string[][] {
  return groups.map((group) => group.models.map((model) => model.id));
}

describe("chat model picker — configured service groups", () => {
  it("T1: returns every connected configured service as its own group", () => {
    const groups = buildConfiguredModelGroups({ services, configuredServices });

    expect(groups.map((group) => group.serviceId)).toEqual([
      "custom:A",
      "custom:B",
      "custom:C",
    ]);
    expect(groups.map((group) => group.serviceName)).toEqual(["A", "B", "C"]);
    expect(modelIds(groups)).toEqual([["a1", "a2"], ["b1", "b2"], ["c1"]]);
  });

  it("T2: never mixes live or discovered models into configured groups", () => {
    const groups = buildConfiguredModelGroups({
      services,
      configuredServices: [
        { service: "custom", name: "A", models: ["a1"] },
        configuredServices[1]!,
        configuredServices[2]!,
      ],
    });

    // The helper has no live catalog input. An upstream A=[a1,a2,a3] probe
    // therefore cannot make a2/a3 appear here.
    expect(modelIds(groups)).toEqual([["a1"], ["b1", "b2"], ["c1"]]);
  });

  it("T3: removes deleted configured models after config refresh", () => {
    const groups = buildConfiguredModelGroups({
      services,
      configuredServices: [
        { service: "custom", name: "A", models: ["a1"] },
        configuredServices[1]!,
        configuredServices[2]!,
      ],
    });

    expect(groups[0]?.models.map((model) => model.id)).toEqual(["a1"]);
    expect(groups.flatMap((group) => group.models.map((model) => model.id))).not.toContain("a2");
  });

  it("T4: selecting B/b2 yields the B/b2 pair instead of an A/b2 mismatch", () => {
    const groups = buildConfiguredModelGroups({ services, configuredServices });
    const bGroup = groups.find((group) => group.serviceId === "custom:B");

    // This is RED on 57843df9 because only the active service group exists.
    expect(bGroup?.models.map((model) => model.id)).toContain("b2");
    expect({ service: bGroup?.serviceId, model: bGroup?.models.find((model) => model.id === "b2")?.id })
      .toEqual({ service: "custom:B", model: "b2" });
  });

  it("T6: duplicate model ids remain independent options per service", () => {
    const groups = buildConfiguredModelGroups({
      services: [services[0]!, services[1]!],
      configuredServices: [
        { service: "custom", name: "A", models: ["shared-model"] },
        { service: "custom", name: "B", models: ["shared-model"] },
      ],
    });

    expect(groups.map((group) => [group.serviceId, group.models[0]?.id])).toEqual([
      ["custom:A", "shared-model"],
      ["custom:B", "shared-model"],
    ]);
  });

  it("T7: a renamed service appears under its new canonical identity", () => {
    const renamedServices = [
      { service: "custom:A", label: "A", connected: true },
      { service: "custom:C", label: "C", connected: true },
    ];
    const groups = buildConfiguredModelGroups({
      services: renamedServices,
      configuredServices: [
        { service: "custom", name: "A", models: ["a1"] },
        { service: "custom", name: "C", models: ["b1", "b2"] },
      ],
    });

    expect(groups.map((group) => group.serviceId)).toEqual(["custom:A", "custom:C"]);
    expect(groups.find((group) => group.serviceId === "custom:C")?.models.map((model) => model.id))
      .toEqual(["b1", "b2"]);
    expect(groups.some((group) => group.serviceId === "custom:B")).toBe(false);
  });

  it("T8: deleting a service removes its group even if a live catalog once contained it", () => {
    const groups = buildConfiguredModelGroups({
      services: [services[0]!],
      configuredServices: [configuredServices[0]!],
    });

    expect(groups.map((group) => group.serviceId)).toEqual(["custom:A"]);
    expect(groups.some((group) => group.serviceId === "custom:B")).toBe(false);
  });

  it("T9: empty configured models do not get filled from live discovery", () => {
    const groups = buildConfiguredModelGroups({
      services: [services[0]!, services[1]!],
      configuredServices: [
        { service: "custom", name: "A", models: [] },
        configuredServices[1]!,
      ],
    });

    expect(groups.map((group) => group.serviceId)).toEqual(["custom:B"]);
    expect(groups.some((group) => group.serviceId === "custom:A")).toBe(false);
  });

  it("T10: excludes disconnected service summaries and keeps connected configured services", () => {
    const groups = buildConfiguredModelGroups({
      services: [
        { ...services[0]!, connected: false },
        services[1]!,
        services[2]!,
      ],
      configuredServices,
    });

    expect(groups.map((group) => group.serviceId)).toEqual(["custom:B", "custom:C"]);
  });

  it("deduplicates model ids only within each service group", () => {
    const groups = buildConfiguredModelGroups({
      services: [services[0]!, services[1]!],
      configuredServices: [
        { service: "custom", name: "A", models: ["shared-model", "SHARED-MODEL", "a2"] },
        { service: "custom", name: "B", models: ["shared-model"] },
      ],
    });

    expect(groups[0]?.models.map((model) => model.id)).toEqual(["shared-model", "a2"]);
    expect(groups[1]?.models.map((model) => model.id)).toEqual(["shared-model"]);
  });

  describe("selection fallback stays inside the selected service", () => {
    it("uses the persisted service/default model on first selection", () => {
      const groups = buildConfiguredModelGroups({ services, configuredServices });
      expect(pickModelSelection(groups, null, null, { service: "custom:B", model: "b2" }))
        .toEqual({ model: "b2", service: "custom:B" });
    });

    it("falls back within A when the selected A model was deleted", () => {
      const groups = buildConfiguredModelGroups({
        services,
        configuredServices: [
          { service: "custom", name: "A", models: ["a1"] },
          configuredServices[1]!,
          configuredServices[2]!,
        ],
      });
      expect(pickModelSelection(groups, "a2", "custom:A", { service: "custom:A", model: "a2" }))
        .toEqual({ model: "a1", service: "custom:A" });
    });

    it("does not keep a cross-service model under A", () => {
      const groups = buildConfiguredModelGroups({ services, configuredServices });
      expect(pickModelSelection(groups, "b1", "custom:A", null))
        .toEqual({ model: "a1", service: "custom:A" });
    });
  });
});

import { describe, expect, it } from "vitest";

describe("browser-safe core imports", () => {
  it("loads the narrative forecast schema without the Node-heavy core root", async () => {
    const forecastSchema = await import("@actalk/inkos-core/forecast/schema");

    expect(forecastSchema.NarrativeForecastSchema).toBeDefined();
  });

  it("loads the project model without the Node-heavy core root", async () => {
    const project = await import("@actalk/inkos-core/models/project");

    expect(project.API_FORMATS).toEqual(["chat", "responses", "anthropic"]);
    expect(project.normalizeApiFormat("anthropic")).toBe("anthropic");
    expect(project.normalizeApiFormat("nope")).toBeUndefined();
  });
});

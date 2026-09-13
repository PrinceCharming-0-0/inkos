import { describe, expect, it } from "vitest";
import {
  buildDoctorModelCandidates,
  buildDoctorProbePlans,
  resolveDoctorModelsBaseUrl,
} from "../commands/doctor.js";

describe("doctor model candidate probing", () => {
  it("keeps the configured model first, then tries discovered models without duplicates", () => {
    const candidates = buildDoctorModelCandidates("google/gemma-4-26b-4b", [
      { id: "google/gemma-4-26b-4b", name: "google/gemma-4-26b-4b" },
      { id: "google/gemma-4-27b-it", name: "google/gemma-4-27b-it" },
      { id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    ]);

    expect(candidates[0]).toBe("google/gemma-4-26b-4b");
    expect(candidates[1]).toBe("google/gemma-4-27b-it");
    expect(candidates[2]).toBe("gemini-2.5-flash");
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("falls back to common compatibility candidates when /models is unavailable", () => {
    const candidates = buildDoctorModelCandidates("missing-model", []);
    expect(candidates[0]).toBe("missing-model");
    expect(candidates).toContain("gpt-5.4");
    expect(candidates).toContain("MiniMax-M2.7");
    expect(candidates).toContain("gemini-2.5-flash");
  });

  it("uses the service-specific models endpoint when the preset defines one", () => {
    const modelsBaseUrl = resolveDoctorModelsBaseUrl(
      "bailian",
      "https://dashscope.aliyuncs.com/apps/anthropic",
      (service) => service === "bailian" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : undefined,
    );

    expect(modelsBaseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

});

describe("buildDoctorProbePlans", () => {
  it("keeps anthropic probes inside the Anthropic family without cross-protocol fallback", () => {
    const plans = buildDoctorProbePlans("anthropic", true);
    expect(plans).toEqual([
      { apiFormat: "anthropic", stream: true },
      { apiFormat: "anthropic", stream: false },
    ]);
  });

  it("keeps chat and responses alternate plans for openai-compatible services", () => {
    expect(buildDoctorProbePlans("chat", true)).toEqual([
      { apiFormat: "chat", stream: true },
      { apiFormat: "chat", stream: false },
      { apiFormat: "responses", stream: false },
      { apiFormat: "responses", stream: true },
    ]);
    expect(buildDoctorProbePlans(undefined, undefined)).toEqual([
      { apiFormat: "responses", stream: false },
      { apiFormat: "responses", stream: true },
      { apiFormat: "chat", stream: false },
      { apiFormat: "chat", stream: true },
    ]);
  });
});

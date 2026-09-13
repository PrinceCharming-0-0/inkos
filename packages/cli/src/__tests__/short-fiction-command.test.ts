import { describe, expect, it } from "vitest";
import { createProgram } from "../program.js";
import {
  buildEnvLLMConfig,
  extractResponsesImageBase64,
  resolveCoverApiKey,
} from "../commands/short-fiction.js";

describe("short command", () => {
  it("registers public short run command", () => {
    const program = createProgram();
    const short = program.commands.find((command) => command.name() === "short");
    expect(short).toBeDefined();
    expect(short?.commands.some((command) => command.name() === "run")).toBe(true);
  });

  it("normalizes INKOS_LLM_API_FORMAT through the shared helper", () => {
    const previous = process.env.INKOS_LLM_API_FORMAT;
    try {
      process.env.INKOS_LLM_BASE_URL = "https://api.example.com/v1";
      process.env.INKOS_LLM_MODEL = "claude-sonnet-4-5";
      process.env.INKOS_LLM_API_FORMAT = "anthropic";
      expect(buildEnvLLMConfig({}).apiFormat).toBe("anthropic");

      process.env.INKOS_LLM_API_FORMAT = "responses";
      expect(buildEnvLLMConfig({}).apiFormat).toBe("responses");

      delete process.env.INKOS_LLM_API_FORMAT;
      expect(buildEnvLLMConfig({}).apiFormat).toBe("chat");

      process.env.INKOS_LLM_API_FORMAT = "bogus";
      expect(buildEnvLLMConfig({}).apiFormat).toBe("chat");
    } finally {
      if (previous === undefined) delete process.env.INKOS_LLM_API_FORMAT;
      else process.env.INKOS_LLM_API_FORMAT = previous;
      delete process.env.INKOS_LLM_BASE_URL;
      delete process.env.INKOS_LLM_MODEL;
    }
  });

  it("exposes cover generation options on short run", () => {
    const program = createProgram();
    const short = program.commands.find((command) => command.name() === "short");
    const run = short?.commands.find((command) => command.name() === "run");
    const optionNames = new Set(run?.options.map((option) => option.long));

    expect(optionNames).toContain("--cover-base-url");
    expect(optionNames).toContain("--cover-endpoint");
    expect(optionNames).toContain("--cover-model");
    expect(optionNames).toContain("--cover-size");
    expect(optionNames).toContain("--cover-api-key-env");
    expect(optionNames).toContain("--no-cover");
  });

  it("exposes writing language without forcing a Chinese length default", () => {
    const program = createProgram();
    const short = program.commands.find((command) => command.name() === "short");
    const run = short?.commands.find((command) => command.name() === "run");
    const languageOption = run?.options.find((option) => option.long === "--lang");
    const lengthOption = run?.options.find((option) => option.long === "--chars");

    expect(languageOption?.defaultValue).toBe("zh");
    expect(lengthOption?.defaultValue).toBeUndefined();
  });

  it("extracts base64 image output from a Responses image_generation_call", () => {
    const payload = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
        { type: "image_generation_call", result: "iVBORw0KGgo=" },
      ],
    };

    expect(extractResponsesImageBase64(payload)).toBe("iVBORw0KGgo=");
  });

  it("requires an explicit cover API key", () => {
    const oldValue = process.env.INKOS_TEST_MISSING_COVER_KEY;
    delete process.env.INKOS_TEST_MISSING_COVER_KEY;
    try {
      expect(() => resolveCoverApiKey("INKOS_TEST_MISSING_COVER_KEY")).toThrow(/API key/i);
    } finally {
      if (oldValue === undefined) delete process.env.INKOS_TEST_MISSING_COVER_KEY;
      else process.env.INKOS_TEST_MISSING_COVER_KEY = oldValue;
    }
  });
});

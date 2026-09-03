import { describe, expect, it, vi } from "vitest";
import {
  buildImportInitPayload,
  buildConfirmSummaryRows,
  defaultImportMetadataForm,
  deriveTitlePlaceholder,
  hasImportSource,
  initialImportAsyncState,
  importDisabledReason,
  metadataStepBlocker,
  previewStepBlocker,
  reduceImportAsync,
  waitForImportReady,
  type ImportPreview,
} from "./import-wizard-state";

const preview: ImportPreview = {
  chapterCount: 2,
  totalChars: 120,
  truncated: false,
  chapters: [
    { index: 1, title: "第一章", charCount: 60 },
    { index: 2, title: "第二章", charCount: 60 },
  ],
};

describe("reduceImportAsync", () => {
  it("starts idle", () => {
    expect(initialImportAsyncState()).toEqual({ phase: "idle" });
  });

  it("previewReady stores the preview with the regex used", () => {
    const next = reduceImportAsync({ phase: "previewing" }, { type: "previewReady", preview, regex: "第\\d+章" });
    expect(next.phase).toBe("idle");
    expect(next.preview?.chapterCount).toBe(2);
    expect(next.previewRegex).toBe("第\\d+章");
  });

  it("previewFailed drops the stale preview and keeps the real error", () => {
    const withPreview = reduceImportAsync(initialImportAsyncState(), { type: "previewReady", preview, regex: "" });
    const next = reduceImportAsync(withPreview, { type: "previewFailed", error: "boom" });
    expect(next.phase).toBe("idle");
    expect(next.preview).toBeUndefined();
    expect(next.previewRegex).toBeUndefined();
    expect(next.error).toBe("boom");
  });

  it("create transitions carry the book id and real error", () => {
    let state = reduceImportAsync(initialImportAsyncState(), { type: "previewReady", preview, regex: "" });
    state = reduceImportAsync(state, { type: "createStarted", bookId: "my-book" });
    expect(state.phase).toBe("creating");
    expect(state.bookId).toBe("my-book");
    state = reduceImportAsync(state, { type: "createFailed", error: "LLM timeout" });
    expect(state.phase).toBe("failed");
    expect(state.error).toBe("LLM timeout");
    // Retry keeps preview so the user does not have to re-preview.
    state = reduceImportAsync(state, { type: "createStarted", bookId: "my-book" });
    expect(state.phase).toBe("creating");
    expect(state.preview).toEqual(preview);
  });

  it("reset returns to idle", () => {
    const state = reduceImportAsync(initialImportAsyncState(), { type: "createDone", bookId: "b" });
    expect(reduceImportAsync(state, { type: "reset" })).toEqual({ phase: "idle" });
  });
});

describe("source", () => {
  it("requires a file or pasted text", () => {
    expect(hasImportSource({ file: null, pastedText: "" })).toBe(false);
    expect(hasImportSource({ file: null, pastedText: "  " })).toBe(false);
    expect(hasImportSource({ file: new File(["x"], "a.txt"), pastedText: "" })).toBe(true);
    expect(hasImportSource({ file: null, pastedText: "第一章 你好" })).toBe(true);
  });

  it("derives a title placeholder from the file name", () => {
    expect(deriveTitlePlaceholder({ file: new File([], "第03章_风暴.txt"), pastedText: "" })).toBe("第03章_风暴");
    expect(deriveTitlePlaceholder({ file: null, pastedText: "text" })).toBe("");
  });
});

describe("step blockers", () => {
  it("blocks preview step without a preview / with zero chapters / with changed regex", () => {
    expect(previewStepBlocker(initialImportAsyncState(), "")).toBe("no-preview");
    const zero: ImportPreview = { ...preview, chapterCount: 0, chapters: [] };
    const zeroState = reduceImportAsync(initialImportAsyncState(), { type: "previewReady", preview: zero, regex: "" });
    expect(previewStepBlocker(zeroState, "")).toBe("zero-chapters");
    const ready = reduceImportAsync(initialImportAsyncState(), { type: "previewReady", preview, regex: "a" });
    expect(previewStepBlocker(ready, "a")).toBeNull();
    expect(previewStepBlocker(ready, "b")).toBe("preview-regex-changed");
  });

  it("blocks metadata step on missing title or non-positive integers", () => {
    const form = defaultImportMetadataForm("zh");
    expect(metadataStepBlocker(form)).toBe("invalid-title");
    expect(metadataStepBlocker({ ...form, title: "书" })).toBeNull();
    expect(metadataStepBlocker({ ...form, title: "书", targetChapters: "0" })).toBe("invalid-numbers");
    expect(metadataStepBlocker({ ...form, title: "书", chapterWordCount: "-5" })).toBe("invalid-numbers");
    expect(metadataStepBlocker({ ...form, title: "书", chapterWordCount: "3.5" })).toBe("invalid-numbers");
  });
});

describe("buildImportInitPayload", () => {
  it("applies defaults and omits empty optional fields", () => {
    const payload = buildImportInitPayload(
      { ...defaultImportMetadataForm("zh"), title: " 我的书 ", genre: "" },
      { storedPath: ".inkos/uploads/import-source/x.txt" },
      "  ",
    );
    expect(payload).toEqual({
      title: "我的书",
      genre: "other",
      language: "zh",
      targetChapters: 200,
      chapterWordCount: 3000,
      storedPath: ".inkos/uploads/import-source/x.txt",
    });
  });

  it("includes a trimmed split regex when present", () => {
    const payload = buildImportInitPayload(
      { ...defaultImportMetadataForm("zh"), title: "书" },
      { text: "第一章 ..." },
      " ^第[\\d一二]+章 ",
    );
    expect(payload.splitRegex).toBe("^第[\\d一二]+章");
    expect(payload.text).toBe("第一章 ...");
  });
});

describe("confirm summary", () => {
  it("lists source, chapter stats and metadata truthfully", () => {
    const rows = buildConfirmSummaryRows({
      source: { file: new File([], "novel.txt"), pastedText: "" },
      form: { ...defaultImportMetadataForm("zh"), title: "书" },
      preview,
    });
    const labels = rows.map((r) => r.label);
    expect(labels).toContain("来源");
    expect(labels).toContain("章节数");
    expect(rows.find((r) => r.label === "章节数")?.value).toBe("2");
    expect(rows.find((r) => r.label === "总字数")?.value).toBe("120");
    expect(rows.find((r) => r.label === "题材")?.value).not.toBe("");
  });
});

describe("waitForImportReady", () => {
  it("resolves when status leaves creating (ready)", async () => {
    const statuses = [{ status: "creating" }, { status: "creating" }, { status: "ready" }];
    const waits: number[] = [];
    await waitForImportReady("b", {
      fetchStatus: async () => statuses.shift() ?? { status: "ready" },
      waitImpl: async (ms) => { waits.push(ms); },
    });
    expect(waits).toHaveLength(2);
  });

  it("throws the real server error on error status", async () => {
    await expect(waitForImportReady("b", {
      fetchStatus: async () => ({ status: "error", error: "LLM timeout at chapter 5" }),
    })).rejects.toThrow("LLM timeout at chapter 5");
  });

  it("treats missing status as an interrupted, retryable import", async () => {
    await expect(waitForImportReady("b", { fetchStatus: async () => ({ status: "missing" }) }))
      .rejects.toThrow(/中断|interrupted/i);
  });

  it("times out with an honest still-running message", async () => {
    await expect(waitForImportReady("b", {
      fetchStatus: async () => ({ status: "creating" }),
      maxAttempts: 2,
      waitImpl: async () => {},
    })).rejects.toThrow(/仍在进行中|still running/i);
  });

  it("falls back to create-status polling by default", async () => {
    const statuses = [{ status: "creating" }, { status: "ready" }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(statuses.shift()), { status: 200 })));
    try {
      await waitForImportReady("b", { waitImpl: async () => {}, delayMs: 1 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("importDisabledReason", () => {
  it("returns a non-empty reason for every key", () => {
    for (const key of [
      "no-source",
      "no-preview",
      "preview-regex-changed",
      "zero-chapters",
      "invalid-title",
      "invalid-numbers",
      "import-running",
    ] as const) {
      expect(importDisabledReason(key).length).toBeGreaterThan(0);
    }
  });
});

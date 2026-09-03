import { tr } from "../lib/app-language";
import { fetchJson } from "../hooks/use-api";

/**
 * Pure state model for the "Import existing work" wizard (IMP-01/03).
 *
 * Two orthogonal concerns, kept separate:
 * - WizardStep: pure UI navigation (file → preview → metadata → confirm).
 * - ImportAsyncState: server-backed async operation state (preview call and
 *   create-and-import call). The UI reflects it; it never fabricates progress.
 */

export type ImportWizardStep = "file" | "preview" | "metadata" | "confirm";

export const IMPORT_WIZARD_STEPS: ReadonlyArray<ImportWizardStep> = [
  "file",
  "preview",
  "metadata",
  "confirm",
];

export interface ImportPreviewChapter {
  readonly index: number;
  readonly title: string;
  readonly charCount: number;
}

/** Mirrors POST /api/v1/import/preview response. */
export interface ImportPreview {
  readonly chapterCount: number;
  readonly totalChars: number;
  readonly truncated: boolean;
  readonly chapters: ReadonlyArray<ImportPreviewChapter>;
}

export type ImportAsyncPhase =
  | "idle"
  | "previewing"
  | "creating"
  | "done"
  | "failed";

export interface ImportAsyncState {
  readonly phase: ImportAsyncPhase;
  /** Last successful preview, plus the split regex it was generated with. */
  readonly preview?: ImportPreview;
  readonly previewRegex?: string;
  readonly bookId?: string;
  /** Real server error message; only set on failed phases. */
  readonly error?: string;
}

export function initialImportAsyncState(): ImportAsyncState {
  return { phase: "idle" };
}

export type ImportAsyncEvent =
  | { readonly type: "previewStarted" }
  | { readonly type: "previewReady"; readonly preview: ImportPreview; readonly regex: string }
  | { readonly type: "previewFailed"; readonly error: string }
  | { readonly type: "createStarted"; readonly bookId: string }
  | { readonly type: "createFailed"; readonly error: string }
  | { readonly type: "createDone"; readonly bookId: string }
  | { readonly type: "reset" };

export function reduceImportAsync(
  state: ImportAsyncState,
  event: ImportAsyncEvent,
): ImportAsyncState {
  switch (event.type) {
    case "previewStarted":
      return { phase: "previewing" };
    case "previewReady":
      return { phase: "idle", preview: event.preview, previewRegex: event.regex, error: undefined };
    case "previewFailed":
      // Stay on the file step with the real error; drop the stale preview so a
      // changed source can never advance with mismatched preview data.
      return { phase: "idle", preview: undefined, previewRegex: undefined, error: event.error };
    case "createStarted":
      return { ...state, phase: "creating", bookId: event.bookId, error: undefined };
    case "createFailed":
      return { ...state, phase: "failed", error: event.error };
    case "createDone":
      return { ...state, phase: "done", bookId: event.bookId, error: undefined };
    case "reset":
      return initialImportAsyncState();
  }
}

// ---------------------------------------------------------------------------
// Source (file / pasted text)
// ---------------------------------------------------------------------------

export interface ImportSourceState {
  readonly file: File | null;
  readonly pastedText: string;
}

export function hasImportSource(source: ImportSourceState): boolean {
  return Boolean(source.file) || source.pastedText.trim().length > 0;
}

export function sourceLabel(source: ImportSourceState): string {
  if (source.file) return source.file.name;
  const text = source.pastedText.trim();
  if (!text) return "";
  return tr("粘贴文本", "Pasted text");
}

/** "第03章_风暴.txt" → "第03章_风暴" → title placeholder for the metadata step. */
export function deriveTitlePlaceholder(source: ImportSourceState): string {
  if (source.file) {
    return source.file.name.replace(/\.[^.]+$/u, "").trim();
  }
  return "";
}

/** dataUrl for POST /import/source/upload (same convention as canon upload). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export interface ImportSourcePayload {
  readonly storedPath?: string;
  readonly text?: string;
}

/**
 * Build the source section shared by /import/preview and /books/import/init.
 * File sources are uploaded first; pasted text travels inline.
 */
export async function buildImportSourcePayload(
  source: ImportSourceState,
  upload: (body: { filename: string; dataUrl: string }) => Promise<{ storedPath: string }>,
): Promise<ImportSourcePayload> {
  if (source.file) {
    const uploaded = await upload({
      filename: source.file.name,
      dataUrl: await fileToDataUrl(source.file),
    });
    return { storedPath: uploaded.storedPath };
  }
  if (source.pastedText.trim()) {
    return { text: source.pastedText };
  }
  throw new Error(tr("请先选择文件或粘贴文本。", "Choose a file or paste text first."));
}

// ---------------------------------------------------------------------------
// Step gating + disabled reasons (UX-01: every disabled action explains itself)
// ---------------------------------------------------------------------------

export type ImportDisabledReasonKey =
  | "no-source"
  | "no-preview"
  | "preview-regex-changed"
  | "zero-chapters"
  | "invalid-title"
  | "invalid-numbers"
  | "import-running";

export function importDisabledReason(
  key: ImportDisabledReasonKey,
): string {
  switch (key) {
    case "no-source":
      return tr("请先选择 TXT/MD 文件或粘贴文本", "Choose a TXT/MD file or paste text first");
    case "no-preview":
      return tr("请先生成章节预览", "Generate the chapter preview first");
    case "preview-regex-changed":
      return tr("分割正则已修改，请重新生成预览", "Split regex changed — regenerate the preview first");
    case "zero-chapters":
      return tr("未识别到任何章节，无法继续", "No chapters detected — cannot continue");
    case "invalid-title":
      return tr("请填写书名", "Enter a book title first");
    case "invalid-numbers":
      return tr("目标章数 / 每章字数必须是正整数", "Target chapters / words per chapter must be positive integers");
    case "import-running":
      return tr("导入进行中，请等待完成或失败后重试", "Import is running — wait for it to finish or fail before retrying");
  }
}

export interface ImportMetadataForm {
  readonly title: string;
  readonly genre: string;
  readonly language: "zh" | "en";
  readonly targetChapters: string;
  readonly chapterWordCount: string;
}

export function defaultImportMetadataForm(language: "zh" | "en"): ImportMetadataForm {
  return {
    title: "",
    genre: "",
    language,
    targetChapters: "200",
    chapterWordCount: language === "en" ? "2000" : "3000",
  };
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === value.trim() ? parsed : null;
}

/** Reason the preview step cannot advance, or null when it can. */
export function previewStepBlocker(
  asyncState: ImportAsyncState,
  currentRegex: string,
): ImportDisabledReasonKey | null {
  if (!asyncState.preview) return "no-preview";
  if ((asyncState.preview.chapterCount ?? 0) === 0) return "zero-chapters";
  if ((asyncState.previewRegex ?? "") !== currentRegex) return "preview-regex-changed";
  return null;
}

export function metadataStepBlocker(form: ImportMetadataForm): ImportDisabledReasonKey | null {
  if (!form.title.trim()) return "invalid-title";
  if (!parsePositiveInteger(form.targetChapters) || !parsePositiveInteger(form.chapterWordCount)) {
    return "invalid-numbers";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Final import request
// ---------------------------------------------------------------------------

export interface ImportInitPayload {
  readonly title: string;
  readonly genre: string;
  readonly language: "zh" | "en";
  readonly targetChapters: number;
  readonly chapterWordCount: number;
  readonly storedPath?: string;
  readonly text?: string;
  readonly splitRegex?: string;
}

export function buildImportInitPayload(
  form: ImportMetadataForm,
  source: ImportSourcePayload,
  splitRegex: string,
): ImportInitPayload {
  const targetChapters = parsePositiveInteger(form.targetChapters);
  const chapterWordCount = parsePositiveInteger(form.chapterWordCount);
  if (!form.title.trim() || !targetChapters || !chapterWordCount) {
    throw new Error(importDisabledReason("invalid-title"));
  }
  return {
    title: form.title.trim(),
    genre: form.genre.trim() || "other",
    language: form.language,
    targetChapters,
    chapterWordCount,
    ...source,
    ...(splitRegex.trim() ? { splitRegex: splitRegex.trim() } : {}),
  };
}

/** Real staged summary rows for the confirm step (no fabricated percentages). */
export function buildConfirmSummaryRows(input: {
  readonly source: ImportSourceState;
  readonly form: ImportMetadataForm;
  readonly preview: ImportPreview;
}): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  return [
    { label: tr("来源", "Source"), value: sourceLabel(input.source) },
    { label: tr("章节数", "Chapters"), value: String(input.preview.chapterCount) },
    { label: tr("总字数", "Total characters"), value: String(input.preview.totalChars) },
    { label: tr("书名", "Title"), value: input.form.title.trim() },
    { label: tr("题材", "Genre"), value: input.form.genre.trim() || tr("其他", "Other") },
    { label: tr("目标章数", "Target chapters"), value: input.form.targetChapters },
    { label: tr("每章字数", "Words per chapter"), value: input.form.chapterWordCount },
  ];
}

// ---------------------------------------------------------------------------
// Async completion wait (create-and-import can run for a long time: foundation
// generation + one LLM replay per chapter). Unlike the plain book-create wait,
// a bare/partial book from a previous failed run must NOT count as success —
// only the create-status contract (creating / error / ready) is authoritative.
// ---------------------------------------------------------------------------

export interface WaitForImportReadyOptions {
  readonly fetchStatus?: (bookId: string) => Promise<{ readonly status: string; readonly error?: string }>;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly waitImpl?: (ms: number) => Promise<void>;
}

export const DEFAULT_IMPORT_WAIT_MAX_ATTEMPTS = 1200;
export const DEFAULT_IMPORT_WAIT_DELAY_MS = 3000;

export async function waitForImportReady(
  bookId: string,
  options: WaitForImportReadyOptions = {},
): Promise<void> {
  const fetchStatus = options.fetchStatus ?? (async (id: string) => {
    try {
      return await fetchJson<{ status: string; error?: string }>(
        `/books/${encodeURIComponent(id)}/create-status`,
      );
    } catch {
      // 404: no in-memory entry and the foundation is incomplete — the import
      // was interrupted (e.g. server restart). Surface as "missing".
      return { status: "missing" };
    }
  });
  const maxAttempts = options.maxAttempts ?? DEFAULT_IMPORT_WAIT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_IMPORT_WAIT_DELAY_MS;
  const waitImpl = options.waitImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await fetchStatus(bookId);
    if (status.status === "error") {
      throw new Error(status.error || tr(`导入 "${bookId}" 失败。`, `Import of "${bookId}" failed.`));
    }
    if (status.status === "missing") {
      throw new Error(tr(
        `导入 "${bookId}" 被中断（服务器重启或进程退出）。可直接重试，会从已导入章节继续。`,
        `Import of "${bookId}" was interrupted (server restart). You can retry — it resumes from the imported chapters.`,
      ));
    }
    if (status.status !== "creating") {
      return;
    }
    if (attempt < maxAttempts - 1) {
      await waitImpl(delayMs);
    }
  }
  throw new Error(tr(
    `导入 "${bookId}" 仍在进行中。可稍后重试，会从已导入章节继续。`,
    `Import of "${bookId}" is still running. Retry later — it resumes from the imported chapters.`,
  ));
}

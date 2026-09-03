import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { FileInput, Loader2, RotateCcw, Upload } from "lucide-react";
import { fetchJson, invalidateApiPaths, postApi } from "../hooks/use-api";
import { useNewSSEMessages, type SSEMessage, type useSSE } from "../hooks/use-sse";
import type { Theme } from "../hooks/use-theme";
import { useI18n } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import { tr } from "../lib/app-language";
import {
  IMPORT_WIZARD_STEPS,
  buildConfirmSummaryRows,
  buildImportInitPayload,
  buildImportSourcePayload,
  defaultImportMetadataForm,
  deriveTitlePlaceholder,
  hasImportSource,
  importDisabledReason,
  initialImportAsyncState,
  metadataStepBlocker,
  previewStepBlocker,
  reduceImportAsync,
  waitForImportReady,
  type ImportMetadataForm,
  type ImportPreview,
  type ImportSourceState,
  type ImportWizardStep,
} from "./import-wizard-state";

interface Nav { toBook: (bookId: string) => void }

type SseState = ReturnType<typeof useSSE>;

const MAX_PROGRESS_LINES = 8;

const STEP_LABELS: Record<ImportWizardStep, { zh: string; en: string }> = {
  file: { zh: "选择文件", en: "Choose file" },
  preview: { zh: "章节预览", en: "Preview" },
  metadata: { zh: "书籍信息", en: "Book info" },
  confirm: { zh: "确认导入", en: "Confirm" },
};

/**
 * "Import existing work as a new book" wizard (IMP-01/IMP-03).
 *
 * All chapter parsing happens server-side through the same core parser
 * (loadChaptersFromPath / splitChapters) used by the final import — this
 * component only collects the source, displays the server preview, and
 * reflects the real async import stages (SSE log + create-status polling).
 */
export function ImportWizard({ nav, theme, sse }: { nav: Nav; theme: Theme; sse: SseState }) {
  const c = useColors(theme);
  const { lang } = useI18n();
  const [step, setStep] = useState<ImportWizardStep>("file");
  const [source, setSource] = useState<ImportSourceState>({ file: null, pastedText: "" });
  const [splitRegex, setSplitRegex] = useState("");
  const [asyncState, dispatch] = useReducer(reduceImportAsync, undefined, initialImportAsyncState);
  const [form, setForm] = useState<ImportMetadataForm>(() => defaultImportMetadataForm(lang));
  const [progressLines, setProgressLines] = useState<ReadonlyArray<string>>([]);
  const [error, setError] = useState<string | null>(null);
  const importRunning = useRef(false);

  const preview = asyncState.preview;
  const previewBlocker = preview ? previewStepBlocker(asyncState, splitRegex) : "no-preview" as const;
  const metadataBlocker = metadataStepBlocker(form);

  // Real import stages from the server's import-scoped log stream.
  const handleSseMessage = useCallback((message: SSEMessage) => {
    if (message.event !== "log") return;
    const data = message.data as { tag?: string; message?: string } | null;
    if (data?.tag !== "import" || !data.message) return;
    setProgressLines((prev) => [...prev.slice(-(MAX_PROGRESS_LINES - 1)), data.message!]);
  }, []);
  useNewSSEMessages(sse.messages, handleSseMessage);

  const busy = asyncState.phase === "previewing" || asyncState.phase === "creating";

  const handleFileChange = (file: File | null) => {
    setSource({ file, pastedText: "" });
    setError(null);
    if (file) {
      const derived = deriveTitlePlaceholder({ file, pastedText: "" });
      setForm((prev) => (prev.title.trim() ? prev : { ...prev, title: derived }));
    }
  };

  const handlePreview = async () => {
    setError(null);
    dispatch({ type: "previewStarted" });
    try {
      const src = await buildImportSourcePayload(source, (body) =>
        postApi<{ storedPath: string }>("/import/source/upload", body));
      const result = await postApi<ImportPreview>("/import/preview", {
        ...src,
        ...(splitRegex.trim() ? { splitRegex: splitRegex.trim() } : {}),
      });
      dispatch({ type: "previewReady", preview: result, regex: splitRegex });
      setStep("preview");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      dispatch({ type: "previewFailed", error: message });
      setError(message);
    }
  };

  const handleStartImport = async () => {
    if (importRunning.current) return;
    setError(null);
    setProgressLines([]);
    importRunning.current = true;
    let bookId: string | null = null;
    try {
      const src = await buildImportSourcePayload(source, (body) =>
        postApi<{ storedPath: string }>("/import/source/upload", body));
      const payload = buildImportInitPayload(form, src, splitRegex);
      const res = await postApi<{ status: string; bookId: string }>("/books/import/init", payload);
      bookId = res.bookId;
      dispatch({ type: "createStarted", bookId: res.bookId });
      await waitForImportReady(res.bookId);
      dispatch({ type: "createDone", bookId: res.bookId });
      invalidateApiPaths(["/api/v1/books", `/api/v1/books/${res.bookId}`]);
      nav.toBook(res.bookId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      dispatch({ type: "createFailed", error: message });
      setError(message);
    } finally {
      importRunning.current = false;
    }
  };

  const handleReset = () => {
    dispatch({ type: "reset" });
    setStep("file");
    setProgressLines([]);
    setError(null);
  };

  const stepIndex = IMPORT_WIZARD_STEPS.indexOf(step);
  const fileSourceMissing = useMemo(() => !hasImportSource(source), [source]);

  const previewReason = previewBlocker ? importDisabledReason(previewBlocker) : null;
  const metadataReason = metadataBlocker ? importDisabledReason(metadataBlocker) : null;

  return (
    <div className="space-y-4">
      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs">
        {IMPORT_WIZARD_STEPS.map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-border">→</span>}
            <span className={i === stepIndex ? "font-semibold text-foreground" : "text-muted-foreground"}>
              {i + 1}. {tr(STEP_LABELS[s].zh, STEP_LABELS[s].en)}
            </span>
          </span>
        ))}
      </div>

      {error && (
        <div className="text-sm px-3 py-2 rounded-lg bg-destructive/10 text-destructive break-words">{error}</div>
      )}

      {/* Step 1: source file / pasted text */}
      {step === "file" && (
        <>
          <label className={`flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-border bg-secondary/20 px-4 py-4 text-sm hover:bg-secondary/30 ${source.file ? "border-primary/50" : ""}`}>
            <Upload size={18} className="text-primary" />
            <span className="min-w-0 flex-1 truncate">
              {source.file?.name ?? tr("选择 TXT 或 Markdown 文件（EPUB 暂不支持）", "Choose a TXT or Markdown file (EPUB not yet supported)")}
            </span>
            <input
              type="file"
              accept=".txt,.md,.markdown,text/plain,text/markdown"
              className="sr-only"
              disabled={busy}
              onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
            />
          </label>
          <textarea
            value={source.pastedText}
            onChange={(event) => { setSource({ file: null, pastedText: event.target.value }); setError(null); }}
            rows={6}
            disabled={busy}
            placeholder={tr("或在此粘贴章节文本...", "…or paste chapter text here...")}
            className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm resize-none font-mono"
          />
          <input
            type="text"
            value={splitRegex}
            onChange={(event) => setSplitRegex(event.target.value)}
            disabled={busy}
            placeholder={tr("高级设置：自定义章节分割正则（可选，默认识别“第X章/回”与“Chapter N”）", "Advanced: custom split regex (optional; default matches 第X章/回 and Chapter N)")}
            className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm font-mono"
          />
          <div className="flex items-center gap-3">
            <button
              onClick={handlePreview}
              disabled={busy || fileSourceMissing}
              title={busy || fileSourceMissing ? (busy ? tr("正在处理中...", "Working...") : importDisabledReason("no-source")) : undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}
            >
              {asyncState.phase === "previewing" ? tr("解析中...", "Parsing...") : tr("生成章节预览", "Generate preview")}
            </button>
            {(busy || fileSourceMissing) && (
              <span className="text-xs text-muted-foreground">
                {busy ? tr("正在处理中...", "Working...") : importDisabledReason("no-source")}
              </span>
            )}
          </div>
        </>
      )}

      {/* Step 2: server-generated chapter preview (same parser as final import) */}
      {step === "preview" && preview && (
        <>
          <div className="flex flex-wrap gap-4 text-sm">
            <span><span className="text-muted-foreground">{tr("章节数", "Chapters")}：</span><span className="font-semibold">{preview.chapterCount}</span></span>
            <span><span className="text-muted-foreground">{tr("总字数", "Total characters")}：</span><span className="font-semibold">{preview.totalChars}</span></span>
          </div>
          {preview.truncated && (
            <p className="text-xs text-muted-foreground">
              {tr(`仅列出前 ${preview.chapters.length} 章（共 ${preview.chapterCount} 章）。`, `Showing the first ${preview.chapters.length} of ${preview.chapterCount} chapters.`)}
            </p>
          )}
          <div className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border text-sm">
            {preview.chapters.map((ch) => (
              <div key={ch.index} className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">{ch.index}</span>
                <span className="min-w-0 flex-1 truncate">{ch.title || tr("（无标题）", "(untitled)")}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{ch.charCount}</span>
              </div>
            ))}
          </div>
          {previewReason && (
            <p className="text-xs text-amber-600">{previewReason}</p>
          )}
          <div className="flex items-center gap-3">
            <button onClick={() => setStep("file")} disabled={busy} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
              {tr("上一步", "Back")}
            </button>
            <button
              onClick={() => { setStep("metadata"); }}
              disabled={Boolean(previewBlocker)}
              title={previewReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}
            >
              {tr("下一步", "Next")}
            </button>
          </div>
        </>
      )}

      {/* Step 3: minimal metadata, sensible defaults, all editable */}
      {step === "metadata" && (
        <>
          <input
            type="text"
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder={tr("书名（必填）", "Book title (required)")}
            className="w-full px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
          />
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={form.genre}
              onChange={(event) => setForm({ ...form, genre: event.target.value })}
              placeholder={tr("题材（默认：其他）", "Genre (default: other)")}
              className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <select
              value={form.language}
              onChange={(event) => setForm({ ...form, language: event.target.value as "zh" | "en" })}
              className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            >
              <option value="zh">{tr("中文", "Chinese")}</option>
              <option value="en">English</option>
            </select>
            <input
              type="text"
              value={form.targetChapters}
              onChange={(event) => setForm({ ...form, targetChapters: event.target.value })}
              placeholder={tr("目标章数", "Target chapters")}
              className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
            <input
              type="text"
              value={form.chapterWordCount}
              onChange={(event) => setForm({ ...form, chapterWordCount: event.target.value })}
              placeholder={tr("每章字数", "Words per chapter")}
              className="px-3 py-2 rounded-lg bg-secondary/30 border border-border text-sm"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {tr("以上均可留空使用默认值；导入完成后可在书籍设置中修改。", "All fields are optional with sensible defaults; edit them later in book settings.")}
          </p>
          {metadataReason && <p className="text-xs text-amber-600">{metadataReason}</p>}
          <div className="flex items-center gap-3">
            <button onClick={() => setStep("preview")} disabled={busy} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
              {tr("上一步", "Back")}
            </button>
            <button
              onClick={() => setStep("confirm")}
              disabled={Boolean(metadataBlocker)}
              title={metadataReason ?? undefined}
              className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}
            >
              {tr("下一步", "Next")}
            </button>
          </div>
        </>
      )}

      {/* Step 4: confirm summary + real staged import */}
      {step === "confirm" && preview && (
        <>
          <div className="rounded-lg border border-border divide-y divide-border text-sm">
            {buildConfirmSummaryRows({ source, form, preview }).map((row) => (
              <div key={row.label} className="flex items-center gap-3 px-3 py-1.5">
                <span className="w-20 shrink-0 text-muted-foreground">{row.label}</span>
                <span className="min-w-0 flex-1 truncate">{row.value}</span>
              </div>
            ))}
          </div>
          {asyncState.phase === "creating" && (
            <div className="rounded-lg border border-border bg-secondary/20 px-3 py-2 text-sm space-y-1">
              <p className="flex items-center gap-2 text-primary">
                <Loader2 size={14} className="animate-spin" />
                {tr("导入进行中（生成基础设定 → 逐章回放重建状态），完成前请勿关闭页面。", "Importing (foundation generation → per-chapter replay); please keep this page open.")}
              </p>
              {progressLines.map((line, i) => (
                <p key={`${i}-${line}`} className="text-xs text-muted-foreground truncate">{line}</p>
              ))}
            </div>
          )}
          {asyncState.phase === "failed" && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive space-y-2">
              <p className="break-words">{asyncState.error}</p>
              <p className="text-xs">{tr("已导入的章节会保留；重试将从缺失的章节继续。", "Imported chapters are kept; retrying resumes from the missing chapters.")}</p>
            </div>
          )}
          {asyncState.phase === "done" && (
            <p className="text-sm text-emerald-600">{tr("导入完成，正在打开工作区...", "Import complete — opening the workspace...")}</p>
          )}
          <div className="flex items-center gap-3">
            <button onClick={() => setStep("metadata")} disabled={busy} className={`px-4 py-2 text-sm rounded-lg ${c.btnSecondary}`}>
              {tr("上一步", "Back")}
            </button>
            {asyncState.phase === "failed" ? (
              <>
                <button
                  onClick={handleStartImport}
                  className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} inline-flex items-center gap-2`}
                >
                  <RotateCcw size={14} /> {tr("重试导入", "Retry import")}
                </button>
                <button onClick={handleReset} className="text-sm text-muted-foreground hover:text-foreground">
                  {tr("重新开始", "Start over")}
                </button>
              </>
            ) : (
              <button
                onClick={handleStartImport}
                disabled={busy || asyncState.phase === "done"}
                title={busy ? importDisabledReason("import-running") : undefined}
                className={`px-4 py-2 text-sm rounded-lg ${c.btnPrimary} disabled:opacity-30`}
              >
                {asyncState.phase === "creating"
                  ? tr("导入中...", "Importing...")
                  : asyncState.phase === "done"
                    ? tr("导入完成", "Import complete")
                    : tr("开始导入", "Start import")}
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5">
            <FileInput size={12} />
            {tr("预览与最终导入使用同一套服务端章节解析。", "Preview and final import share the same server-side chapter parser.")}
          </p>
        </>
      )}
    </div>
  );
}
